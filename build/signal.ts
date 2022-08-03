import { SignalConstants } from "os";

export function handleAndExit(signal: keyof SignalConstants, handle: (() => void) | (() => Promise<void>)) {
    process.once(signal, async () => {
        await handle()
        process.kill(process.pid, signal)
    })
}
