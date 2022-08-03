import * as http from "node:http"
import * as syncfs from "fs"
import * as fs from "fs/promises"
import * as log from "./log"
import * as signal from "./signal"
import * as sse from "./sse"
import { CleanupHandler } from "./cleanup"
import * as handlebars from "handlebars"
import { marked } from "marked"
import * as event from "node:events"

const startTime = new Date()

const watchClient = `
<script>
const startTime = ${JSON.stringify(startTime)}

async function waitForServer(timeout) {
    document.title = "Waiting for server..."
    // await new Promise(r => setTimeout(r, timeout))

    while (true) {
        // const ac = new AbortController()
        // setTimeout(() => ac.abort(), 100)
        try {
            const response = await fetch("/start-time", {
                // signal: ac.signal,
            })
            const text = await response.text()
            if (text !== startTime)
                break
            await new Promise(r => setTimeout(r, timeout))
        } catch {
            await new Promise(r => setTimeout(r, timeout))
        }
    }
}

const evts = new EventSource("/evt")
evts.addEventListener("compiling", () => {
    document.title = "Compiling..."
})
evts.addEventListener("build-failure", () => {
    document.title = "Build failure :<"
})
evts.addEventListener("something", evt => {
    console.log(evt.data)
    const p = document.createElement("p")
    p.innerText = evt.data
    document.body.appendChild(p)
})
evts.addEventListener("refresh", async () => {
    evts.close()
    console.info("Waiting for the server with a LOW TIMEOUT")
    await waitForServer(10)
    location.reload()
})
evts.addEventListener("reload", async () => {
    evts.close()
    location.reload()
})
evts.addEventListener("error", async evt => {
    evts.close()
    console.error("Error in event connection")
    console.info("Waiting for the server with a HIGH TIMEOUT")
    await waitForServer(3000)
    location.reload()
})
</script>
`

const cleanup = new CleanupHandler()
log.info("Hi!")
cleanup.register(() => {
    log.info("Goodbye!")
    log.debug()
})

async function buildPages() {
    const hb = handlebars.create()
    const xSrc = await fs.readFile("components/x.hbs", "utf-8")
    hb.registerPartial("x", hb.compile(xSrc))

    const pageRenderPromises = (await fs.readdir("pages"))
        .map(async fileName => {
            const src = await fs.readFile(`${process.cwd()}/pages/${fileName}`, "utf-8")
            const md = hb.compile(src)({})
            const html = marked(md)
            return {
                [fileName.replace(/\.md$/, ".html")]: html,
            }
        })

    return (await Promise.all(pageRenderPromises))
        .reduce((a, b) => ({...a, ...b}), {})
}
let pages = buildPages()

log.debug("Starting watcher...")
function startWatching(dirName: string) {
    const watcher = syncfs.watch(dirName, async (type, file) => {
        pages = buildPages()
        await eventServer.broadcast("reload", null)
    })
    cleanup.register(() => {
        log.debug("Closing watcher...")
        watcher.close()
        log.debug("Closed watcher")
    })
}
startWatching("components")
startWatching("pages")
// const watcher = syncfs.watch("components", async (type, file) => {
//     pages = buildPages()
//     await eventServer.broadcast("reload", null)
// })
// cleanup.register(() => {
//     log.debug("Closing watcher...")
//     watcher.close()
//     log.debug("Closed watcher")
// })
log.info("Started watcher")

const eventServer = new sse.EventServer()

function resolvePath(requestURL: string | undefined) {
    switch(requestURL) {
        case undefined:
        case "/":
            return "index.html"
        default:
            return requestURL.substring(1) + ".html"
    }
}

const server = http.createServer(async (request, response) => {
    log.debug("Serving", request.method, request.url)

    if (request.url === "/start-time") {
        response.writeHead(200, {
            "Content-Type": "text/plain",
        })

        response.end(startTime.toJSON())
    } else if (request.url === "/evt") {
        void eventServer.startSending(response)
    } else {
        // const url = new URL(request.url ?? "/")
        const pathName = resolvePath(request.url)
        log.debug("Resolved path", request.url, "to", pathName)
        const page = (await pages)[pathName]
        if (page) {
            response.writeHead(200, "Cool choice!")
            response.end(page + "\n\n" + watchClient)
        } else {
            response.writeHead(404, "Not Found")
            response.end(watchClient)
        }
    }
})
cleanup.register(async () => {
    if (server.listening) {
        log.debug("Stopping server...")
        const closePromise = new Promise((resolve, reject) => {
            server.on("request", (_request, response) => response.destroy())
            server.close((err) => (err ? reject : resolve)(err))
        })
        await closePromise
        log.debug("Stopped server")
    } else {
        log.debug("Server wasn't listening when trying to stop")
    }
})
cleanup.register(() => {
    log.debug("Closing EventServer...")
    eventServer.close()
    log.debug("Closed EventServer")
})

log.debug("Starting server...")
server.listen(8080)
log.info("Started server")

process.on("buildscript-compile", async data => {
    log.info("Recompiling build script...")
    await eventServer.broadcast("compiling", data)
})

process.on("buildscript-failure", async data => {
    log.error("Error while recompiling build script")
    await eventServer.broadcast("build-failure", data)
})

signal.handleAndExit("SIGINT", async () => {
    log.debug("SIGINT! Running cleanup...")
    await cleanup.run()
})
signal.handleAndExit("SIGTERM", async () => {
    log.debug("SIGTERM! Running cleanup...")
    await cleanup.run()
})
signal.handleAndExit("SIGUSR2", async () => {
    log.debug("SIGUSR2! Preparing for restart...")
    if (!eventServer.closed) {
        log.debug("Sending refresh event to clients...")
        await eventServer.broadcast("refresh", null)
        log.debug("Sent refresh event to clients")
    }
    log.debug("Running cleanup...")
    await cleanup.run()
})
