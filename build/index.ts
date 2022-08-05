import * as syncfs from "fs"
import * as fs from "fs/promises"
import * as log from "./log"
import * as signal from "./signal"
import { CleanupHandler } from "./cleanup"
import * as handlebars from "handlebars"
import { marked } from "marked"
import * as fsext from "./fs"
import * as path from "node:path"
import * as hrs from "./server"
import * as pg from "./page"

const pagesPath = `${process.cwd()}/pages`

const cleanup = new CleanupHandler()
log.info("Hi!")
cleanup.register(() => {
    log.info("Goodbye!")
    log.debug()
})

function filePathToPagePath(filePath: string): string {
    const relativePath = path.relative(pagesPath, filePath).replace(/\.md$/, "")
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

async function buildPages(): pg.PageMap {
    const pages = new Map<string, Promise<string>>()

    const hb = handlebars.create()
    const xSrc = await fs.readFile("components/x.hbs", "utf-8")
    hb.registerPartial("x", hb.compile(xSrc))

    const files = fsext.walk(pagesPath)
    for await (const file of files) {
        const pathName = filePathToPagePath(file.path)
        log.debug("Building page", pathName)
        pages.set(pathName, buildPage(hb, file.path))
    }

    return pages
}

const server = new hrs.HotReloadServer(buildPages())
hrs.removeHTMLSuffix(server)

function startWatching(dirName: string) {
    log.debug("Starting watcher for", dirName, "...")

    const watcher = syncfs.watch(dirName, async (type, file) => {
        const p = buildPages()
        server.pages = p
        await p
        await server.eventServer!.broadcast("reload")
    })

    cleanup.register(() => {
        log.debug("Closing watcher for", dirName, "...")
        watcher.close()
        log.debug("Closed watcher")
    })

    log.info("Started watcher for", dirName)
}

startWatching("components")
startWatching(pagesPath)

cleanup.register(() => server.stop())
server.start()

process.on("buildscript-compile", async data => {
    log.info("Recompiling build script...")
    await server.eventServer?.broadcast("compiling", data)
})

process.on("buildscript-failure", async data => {
    log.error("Error while recompiling build script")
    await server.eventServer?.broadcast("build-failure", data)
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

    log.debug("Sending refresh event to clients...")
    await server.eventServer?.broadcast("refresh")
    log.debug("Sent refresh event to clients")

    log.debug("Running cleanup...")
    await cleanup.run()
})
