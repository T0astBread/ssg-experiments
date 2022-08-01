import * as fs from "fs"
import * as handlebars from "handlebars"
import { num } from "./num"

export default function main() {   
    const w = fs.watch("components", (type, file) => {
        console.log(type, file)
    })
    
    console.log(handlebars.compile("foo {{h}}")({
        h: num,
    }))

    return () => {
        console.log("close")
        w.close()
    }
}

const cleanup = main()
// process.on("exit", cleanup)
process.on("SIGTERM", cleanup)
process.on("SIGINT", cleanup)
