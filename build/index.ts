import * as http from "node:http"
import * as syncfs from "fs"
import * as fs from "fs/promises"
import * as log from "./log"
import * as signal from "./signal"
import * as sse from "./sse"
import { CleanupHandler } from "./cleanup"
import * as handlebars from "handlebars"
import { marked } from "marked"
import * as fsext from "./fs"
import * as path from "node:path"

const pagesPath = `${process.cwd()}/pages`
const errorPagesPath = `${process.cwd()}/error-pages`
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

// interface PageEntry {
//     readonly promise: Promise<string>,
//     resolve?: (content: string | undefined) => void,
// }

// class Pages {
//     private doneRendering = false
//     private readonly pagePromises = new Map<string, PageEntry>()

//     async get(path: string): Promise<string | undefined> {
//         const entry = this.pagePromises.get(path)
//         if (entry) {
//             return entry.promise
//         }
//         if (this.doneRendering) {
//             return undefined
//         }
//         const x = new Promise()
//         this.pagePromises.set
//     }

//     add(path: string, content: Promise<string>) {
//         if (this.doneRendering) {
//             throw new Error("Add after rendering has been reported as done")
//         }

//         const existingEntry = this.pagePromises.get(path)
//         if (existingEntry) {
//             if (!existingEntry.resolve) {
//                 throw new Error("Tried to add an existing page")
//             }
//             content.then(existingEntry.resolve)
//             existingEntry.resolve = undefined
//         } else {
//             this.pagePromises.set(path, {
//                 promise: content,
//             })
//         }
//     }

//     notifyDoneRendering() {
//         this.doneRendering = true
//         this.pagePromises.forEach(entry => {
//             entry.resolve?.call(undefined, undefined)
//             entry.resolve = undefined
//         })
//     }

//     clear() {
//         this.doneRendering = false
//         ;[...this.pagePromises.entries()]
//             .filter(([ _, entry ]) => entry.resolve === undefined)
//             .forEach(([ path ]) => this.pagePromises.delete(path))
//     }
// }

// async function buildPages(pages: Pages) {
//     pages.clear()

//     const hb = handlebars.create()
//     const xSrc = await fs.readFile("components/x.hbs", "utf-8")
//     hb.registerPartial("x", hb.compile(xSrc))

//     const files = fsext.walk(`${process.cwd()}/pages`)
//     for await (const file of files) {
//         const path = file.path.replace(/\.md$/, "")
//         pages.add(path, (async () => {
//             const src = await fs.readFile(file.path, "utf-8")
//             const md = hb.compile(src)({})
//             const html = marked(md)
//             return html
//         })())
//     }
// }

// const pages = new Pages()

function filePathToPagePath(dir: string, filePath: string): string {
    const relativePath = path.relative(dir, filePath).replace(/\.md$/, "")
    if (relativePath === "index") {
        return "/"
    }
    return `/${relativePath}`
}

async function buildPage(hb: typeof handlebars, filePath: string): Promise<string> {
    const src = await fs.readFile(filePath, "utf-8")
    const md = hb.compile(src)({})
    const html = marked(md)
    return html
}

async function buildPages(dir: string) {
    const pages = new Map<string, Promise<string>>()

    const hb = handlebars.create()
    const xSrc = await fs.readFile("components/x.hbs", "utf-8")
    hb.registerPartial("x", hb.compile(xSrc))

    const files = fsext.walk(dir)
    for await (const file of files) {
        const pathName = filePathToPagePath(dir, file.path)
        log.debug("Building page", pathName)
        pages.set(pathName, buildPage(hb, file.path))
    }

    return pages
}

let pages = buildPages(pagesPath)
let errorPages = buildPages(errorPagesPath)

log.debug("Starting watcher...")
function startWatching(dirName: string, affectsPages: boolean, affectsErrorPages: boolean) {
    const watcher = syncfs.watch(dirName, async (type, file) => {
        if (affectsPages) {
            pages = buildPages(pagesPath)
        }
        if (affectsErrorPages) {
            errorPages = buildPages(errorPagesPath)
        }
        await pages
        await eventServer.broadcast("reload", null)
    })
    cleanup.register(() => {
        log.debug("Closing watcher...")
        watcher.close()
        log.debug("Closed watcher")
    })
}
startWatching("components", true, true)
startWatching(pagesPath, true, false)
startWatching(errorPagesPath, false, true)
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

// function resolvePath(requestURL: string | undefined) {
//     switch(requestURL) {
//         case undefined:
//         case "/":
//             return "index.html"
//         default:
//             requestURL = requestURL?.replace(/(?:\/|\.html)$/, "")
//             return requestURL.substring(1)
//     }
// }

const server = http.createServer(async (request, response) => {
    log.debug("Serving", request.method, request.url)

    if (request.url !== "/" && request.url?.endsWith("/")) {
        response.writeHead(301, {
            "Location": request.url.substring(0, request.url.length - 1),
        })
        response.end()
    } else if (request.url?.endsWith(".html")) {
        response.writeHead(301, {
            "Location": request.url.substring(0, request.url.length - 5),
        })
        response.end()
    } else if (request.url === "/start-time") {
        response.writeHead(200, {
            "Content-Type": "text/plain",
        })
        response.end(startTime.toJSON())
    } else if (request.url === "/evt") {
        void eventServer.startSending(response)
    } else {
        // const pathName = resolvePath(request.url)
        // log.debug("Resolved path", request.url, "to", pathName)
        const page = await (await pages).get(request.url ?? "/")
        if (page) {
            response.writeHead(200, {
                "Content-Type": "text/html;charset=utf-8",
            })
            response.end(page + "\n\n" + watchClient)
        } else {
            const errorPage = await (await errorPages).get("/404")
            response.writeHead(404, {
                "Content-Type": "text/html;charset=utf-8",
            })
            response.end(`${errorPage ?? ""}\n\n${watchClient}`)
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
