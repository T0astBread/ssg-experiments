export type CleanupFn = () => any | Promise<any>

export class CleanupHandler {
    private readonly cleanupFns: CleanupFn[] = []

    constructor() {
        process.once("uncaughtException", async err => {
            console.error(err)
            await this.run()
        })
    }

    register(cleanupFn: CleanupFn) {
        this.cleanupFns.push(cleanupFn)
    }

    async run() {
        const errs = []
        for (const cleanupFn of this.cleanupFns.reverse()) {
            try {
                await cleanupFn()
            } catch (err) {
                errs.push(err)
            }
        }
        if (errs.length > 0) {
            throw errs
        }
    }
}
