import * as fs from "fs"
import * as handlebars from "handlebars"
import { num } from "./num"
import * as x from "./x.json"

export default function main() {   
    const w = fs.watch("components", (type, file) => {
        console.log(type, file)
    })
    
    console.log(handlebars.compile("foo {{h}} {{i}}")({
        h: num,
        i: x.foo,
    }))

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

["SIGINT", "SIGTERM"].forEach(signal => exit(signal))
