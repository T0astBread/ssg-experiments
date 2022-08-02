import * as fs from "fs"
import * as handlebars from "handlebars"
import { num } from "./num"
import * as x from "./x.json"

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

    return () => {
        console.log("close!")
        w.close()
    }
}

const cleanup = main()
const signalHandlers = new Map<string, Function>()
function exit(signal: string) {
    const handler = () => {
        cleanup()
        process.removeListener(signal, handler)
        process.kill(process.pid, signal)
    }
    signalHandlers.set(signal, handler)
    process.on(signal, handler)
}

process.on("buildscript-failure", console.log)

;["SIGINT", "SIGTERM"].forEach(signal => exit(signal))
