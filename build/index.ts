import * as http from "node:http"
import * as fs from "fs"
import * as handlebars from "handlebars"
import { num } from "./num"
import * as x from "./x.json"
import * as signal from "./signal"
import * as sse from "./sse"

function buildStuff() {
    const hb = handlebars.create()

    hb.registerPartial("x", hb.compile(fs.readFileSync("components/x.hbs", "utf-8")))
    
    console.log(hb.compile("foo {{h}} {{i}} {{#> x}}This is my block!{{/x}}")({
        h: num,
        i: x.foo,
    }))
}

export default function main() {
    console.log("end", new Date())

    buildStuff()

    const w = fs.watch("components", (type, file) => {
        console.log(type, file)
        buildStuff()
    })

    const eventServer = new sse.EventServer()

    const server = http.createServer(async (request, response) => {
        console.log(request.url)

        if (request.url === "/") {
            response.writeHead(200, {
                "Content-Type": "text/html;charset=utf-8",
            })

            response.write(`
                <h1>foo</h1>

                <script type="module">
                    // while (true) {
                    //     const response = await fetch("/long")
                    //     const text = await response.text()
                    //     console.log(text)
                    // }

                    const evts = new EventSource("/evt")
                    evts.addEventListener("something", console.log)
                    evts.addEventListener("error", evt => {
                        console.error("error :<")
                        console.log(evt)
                    })
                </script>
            `)
            response.end()
        } else if (request.url === "/long") {
            await new Promise(r => setTimeout(r, 10000))

            response.writeHead(200, {
                "Content-Type": "text/plain",
            })

            response.end("okay")
        } else if (request.url === "/evt") {
            const sendEvent = eventServer.startSending(response)

            setInterval(() => {
                sendEvent("something", "hi from the server!")
            }, 1000)
        } else {
            response.writeHead(404, "Not Found")
            response.end()
        }
    })
    server.listen(8080)

    return async () => {
        console.log("close!")
        w.close()
        await eventServer.close()
        server.close()
    }
}

const cleanup = main()

process.on("buildscript-failure", console.log)

signal.handleAndExit("SIGINT", cleanup)
signal.handleAndExit("SIGTERM", cleanup)
signal.handleAndExit("SIGUSR2", cleanup)
