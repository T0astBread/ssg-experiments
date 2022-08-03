import * as http from "node:http"
import * as syncfs from "fs"
import * as fs from "fs/promises"
import * as log from "./log"
import * as signal from "./signal"
import * as sse from "./sse"
import { CleanupHandler } from "./cleanup"
import * as handlebars from "handlebars"

const startTime = new Date()
const cleanup = new CleanupHandler()
log.info("Hi!")
cleanup.register(() => {
    log.info("Goodbye!")
    log.debug()
})

async function buildHB() {
    const hb = handlebars.create()
    const xSrc = await fs.readFile("components/x.hbs", "utf-8")
    hb.registerPartial("x", hb.compile(xSrc))

    const pages = {
        "idk": hb.compile("{{#> x}}hello there{{/x}}")({})
    }
    return pages
}
let pages = buildHB()

log.debug("Starting watcher...")
const watcher = syncfs.watch("components", async (type, file) => {
    pages = buildHB()
    await eventServer.broadcast("reload", null)
})
cleanup.register(() => {
    log.debug("Closing watcher...")
    watcher.close()
    log.debug("Closed watcher")
})
log.info("Started watcher")

const eventServer = new sse.EventServer()

const server = http.createServer(async (request, response) => {
    log.debug("Serving", request.method, request.url)

    if (request.url === "/") {
        response.writeHead(200, {
            "Content-Type": "text/html;charset=utf-8",
        })

        response.write(`
            ${(await pages).idk}

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
        `)
        response.end()
    } else if (request.url === "/start-time") {
        response.writeHead(200, {
            "Content-Type": "text/plain",
        })

        response.end(startTime.toJSON())
    } else if (request.url === "/evt") {
        const sendEvent = eventServer.startSending(response)

        const interval = setInterval(() => {
            log.debug("Sending event")
            if (response.closed) {
                log.debug("Sending event - closed!")
                clearInterval(interval)
                return
            }
            sendEvent("something", "hi from the server!")
        }, 500)
        response.once("close", () => {
            log.debug("Stopping events - closed")
            clearInterval(interval)
        })
    } else {
        response.writeHead(404, "Not Found")
        response.end()
    }
})
cleanup.register(async () => {
    if (server.listening) {
        log.debug("Stopping server...")
        const closePromise = new Promise((resolve, reject) => {
            server.on("request", (_request, response) => response.destroy())
            server.close((err) => (err ? reject : resolve)(err))
        })
        // server.closeAllConnections()
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
// const fakeDelay = setTimeout(() => {
//     server.listen(8080)
//     log.debug("HELOOOOOO")
// }, 3000)
// cleanup.register(() => clearTimeout(fakeDelay))
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
