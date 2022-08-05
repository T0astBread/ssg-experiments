import EventEmitter from "node:events"
import * as http from "node:http"

import * as event from "./event"
import { ansi, withPrefix } from "./log"
import * as pg from "./page"
import * as sse from "./sse"

const log = withPrefix(`${ansi(2)}[hrs]${ansi()}`)

const watchClient = (clientExtension: ClientExtension, startTime: Date) => `
<script>
(async () => {
    const startTime = ${JSON.stringify(startTime)}

    async function waitForServer(timeout) {
        document.title = "Waiting for server..."

        while (true) {
            try {
                const response = await fetch("/start-time")
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

    await (${clientExtension.toString()})({ waitForServer }, evts)
})()
</script>
`

export type HotReloadServerEvents = {
    "event-connection-started": (sendEvent: sse.SendFn, request: http.IncomingMessage, response: http.ServerResponse) => void,
    "server-created": (httpServer: http.Server) => void,
    "request": (request: http.IncomingMessage, response: http.ServerResponse) => void,
}

export type ClientExtension = (lib: {
    waitForServer: (timeout: number) => Promise<void>,
}, evts: EventSource) => Promise<void>

export class HotReloadServer {
    private readonly clientExtension: Promise<ClientExtension>

    readonly events = new EventEmitter() as event.TypedEventEmitter<HotReloadServerEvents>
    
    private _httpServer: http.Server | undefined;
    public get httpServer(): http.Server | undefined {
        return this._httpServer;
    }
    private set httpServer(v: http.Server | undefined) {
        this._httpServer = v;
    }

    private _eventServer : sse.EventServer | undefined;
    public get eventServer() : sse.EventServer | undefined {
        return this._eventServer;
    }
    private set eventServer(v : sse.EventServer | undefined) {
        this._eventServer = v;
    }
    
    private _startTime : Date | undefined;
    public get startTime() : Date | undefined {
        return this._startTime;
    }
    private set startTime(v : Date | undefined) {
        this._startTime = v;
    }

    errorPage: pg.ErrorPageFn = async statusCode => ({ path: `/_errors/${statusCode}` })
    pages: pg.PageMap
    
    constructor(pages: pg.PageMap, client: Promise<ClientExtension> = Promise.resolve(() => Promise.resolve())) {
        this.clientExtension = client
        this.pages = pages
    }

    start(port: number = 8080) {
        log.debug("Starting hot reloading server...")

        if (this.startTime) {
            throw new Error("Attempted to start an already running server")
        }

        const startTime = new Date()
        this.startTime = startTime
        const client = this.clientExtension.then(e => watchClient(e, startTime))

        const eventServer = new sse.EventServer()
        this.eventServer = eventServer

        this.httpServer = http.createServer(async (request, response) => {
            log.debug("Serving", request.method, request.url)

            this.events.emit("request", request, response)
        
            if (request.url === "/start-time") {
                response.writeHead(200, {
                    "Content-Type": "text/plain",
                })
                response.end(startTime.toJSON())
            } else if (request.url === "/evt") {
                const send = eventServer.startSending(response)
                this.events.emit("event-connection-started", send, request, response)
            } else {
                const page = await (await this.pages).get(request.url ?? "/")
                if (page) {
                    response.writeHead(200, {
                        "Content-Type": "text/html;charset=utf-8",
                    })
                    response.end(`${page}\n\n${await client}`)
                } else {
                    const errorPage = await this.errorPage(404)
                    response.writeHead(404, {
                        "Content-Type": "text/html;charset=utf-8",
                    })
                    if (errorPage) {
                        const p = "content" in errorPage
                            ? errorPage
                            : await (await this.pages).get(errorPage.path)
                        response.end(`${p ?? "404"}\n\n${await client}`)
                    }
                }
            }
        })

        this.events.emit("server-created", this.httpServer)

        this.httpServer.listen(port)

        log.debug("Started hot reloading server")
    }

    async stop() {
        log.debug("Stopping hot reloading server...")

        if (!this.startTime) {
            log.debug("Server wasn't running when trying to stop")
            return
        }

        const server = this.httpServer
        if (!server) {
            throw new Error("HTTP server was undefined when trying to stop")
        }


        log.debug("Closing EventServer...")
        await this.eventServer!.close()
        this.eventServer = undefined
        log.debug("Closed EventServer")

        if (server.listening) {
            log.debug("Stopping HTTP server...")
            const closePromise = new Promise((resolve, reject) => {
                server.on("request", (_request, response) => response.destroy())
                server.close((err) => (err ? reject : resolve)(err))
            })
            await closePromise
            log.debug("Stopped HTTP server")
        } else {
            log.debug("HTTP server wasn't listening when trying to stop")
        }

        this.startTime = undefined

        log.debug("Stopped hot reloading server")
    }
}

export function removeHTMLSuffix(server: HotReloadServer) {
    server.events.on("request", (request, response) => {
        if (request.url?.endsWith(".html")) {
            response.writeHead(301, {
                "Location": request.url.substring(0, request.url.length - 5),
            })
            response.end()
        }
    })
}
