import * as fs from "fs"
import * as handlebars from "handlebars"
import { num } from "./num"

export default function() {
    const w = fs.watch("components", (type, file) => {
        console.log(type, file)
    })
    
    console.log(handlebars.compile("foo {{h}}")({
        h: num,
    }))

    return () => {
        w.close()
    }
}
