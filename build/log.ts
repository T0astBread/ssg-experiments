export const PREFIX = "[build]"

const wantsVerboseOutput = ["1", "true"].includes(process.env.VERBOSE_BUILD || "")

export function debug(...args: any[]) {
    if (wantsVerboseOutput)
        console.debug(PREFIX, ...args)
}

export function info(...args: any[]) {
    if (wantsVerboseOutput)
        console.info(PREFIX, ...args)
}

export function error(...args: any[]) {
    console.info(PREFIX, ...args)
}

export function withPrefix(prefix: string) {
    return {
        debug(...args: any[]) {
            debug(prefix, ...args)
        },
        
        info(...args: any[]) {
            info(prefix, ...args)
        },
        
        error(...args: any[]) {
            error(prefix, ...args)
        },
    }
}
