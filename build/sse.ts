import * as http from "node:http"

async function sendEvent(connection: http.ServerResponse, event: string, data: any) {
    return new Promise((resolve, reject) => {
        connection.write(`event: ${event}
data: ${data}

`, err => (err ? reject : resolve)(err))
    })
}

export class EventServer {
    private readonly connections: http.ServerResponse[] = []

    startSending(httpResponse: http.ServerResponse) {
        const id = this.connections.push(httpResponse) - 1
        httpResponse.once("close", () => {
            delete this.connections[id]
        })
        httpResponse.writeHead(200, {
            "Content-Type": "text/event-stream",
        })
        httpResponse.flushHeaders()

        return (event: string, data: any) => sendEvent(httpResponse, event, data)
    }

    async broadcast(event: string, data: any) {
        return Promise.all(this.connections.map(connection =>
            sendEvent(connection, event, data)))
    }

    async close() {
        return Promise.all(this.connections.map(connection => {
            connection.removeAllListeners("close")
            return new Promise(resolve => connection.end(resolve))
        }))
    }
}
