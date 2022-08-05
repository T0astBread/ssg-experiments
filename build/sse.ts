import * as http from "node:http"
import { ansi, withPrefix } from "./log"

const log = withPrefix(`${ansi(2)}[sse]${ansi()}`)

async function sendEvent(connection: http.ServerResponse, event: string, data: any) {
    log.debug("Sending event:", event)
    await Promise.race([
        new Promise((resolve, reject) => {
            connection.write(`event: ${event}
data: ${data}

`, err => (err ? reject : resolve)(err))
        }),
    ])
}

export type SendFn = (event: string, data: any) => Promise<void>

export class EventServer {
    private _closed = false
    public get closed() {
        return this._closed
    }
    private set closed(v: boolean) {
        this._closed = v
    }
    
    private nextID = 0
    private readonly connections = new Map<number, http.ServerResponse>()

    startSending(httpResponse: http.ServerResponse): SendFn {
        if (this.closed) {
            throw new Error("startSending after close")
        }

        const id = this.nextID++
        this.connections.set(id, httpResponse)
        httpResponse.once("finish", () => {
            this.connections.delete(id)
        })
        httpResponse.once("close", () => {
            this.connections.delete(id)
        })
        httpResponse.writeHead(200, {
            "Content-Type": "text/event-stream",
        })
        httpResponse.flushHeaders()

        return (event: string, data: any) => sendEvent(httpResponse, event, data)
    }

    async broadcast(event: string, data?: any) {
        if (this.closed) {
            throw new Error("broadcast after close")
        }

        log.debug("Broadcast:", event)

        const errs: Error[] = []

        await Promise.all([...this.connections.values()]
            .map(connection =>
                sendEvent(connection, event, data)
                    .catch(err => errs.push(err))))

        if (errs.length > 0) {
            throw errs
        }
    }

    async close() {
        this.closed = true

        log.debug("Closing...")

        return Promise.all([...this.connections.values()].map(connection => {
            return new Promise(resolve => connection.end(resolve))
        }))
    }
}
