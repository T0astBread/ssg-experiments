export type PageMap = Promise<Map<string, Promise<string>>>

export type ErrorPageFn = (statusCode: number) => Promise<{ path: string } | { content: string } | undefined>
