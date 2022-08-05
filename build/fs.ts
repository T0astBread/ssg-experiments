import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as syncfs from "node:fs"

export interface WalkEntry {
    dir: syncfs.Dirent
    path: string
}

export async function* walk(dir: string): AsyncGenerator<WalkEntry> {
    for await (const d of await fs.opendir(dir)) {
        const entry = {
            dir: d,
            path: path.join(dir, d.name),
        }
        if (d.isDirectory()) {
            yield* walk(entry.path)
        } else {
            yield entry
        }
    }
}
