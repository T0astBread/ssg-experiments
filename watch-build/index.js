#!/usr/bin/env node

// Copied and adapted from https://github.com/Microsoft/TypeScript/wiki/Using-the-Compiler-API#writing-an-incremental-program-watcher

const cp = require("node:child_process")
const fs = require("node:fs/promises")
const ts = require("typescript")

const COMPILE_TIMER_LABEL = "Compiling build script took"
const LOG_PREFIX = "\033[34m[watch-build]\033[m"

/** @type Map<string, Function> */
const signalListeners = new Map()
const wantsVerboseOutput = ["1", "true"].includes(
	process.env.VERBOSE_WATCH_BUILD
)

/** @type Set<string> */
let filesEmittedInLastRun = new Set()
/** @type Set<string> */
let filesEmittedInRunBeforeLastRun = new Set()
let hasDiagnostics = false
/** @type string | undefined */
let killedBy = undefined
/** @type cp.ChildProcess | undefined */
let nodeProcess = undefined
/** @type cp.ChildProcess | undefined */
let nodeProcessStandby = undefined
let watcher = undefined
/** @type Function | undefined */
let watcherPromiseResolve = undefined
let watcherPromise = new Promise(r => {
	watcherPromiseResolve = r
})

function debug(...args) {
	if (wantsVerboseOutput) console.debug(LOG_PREFIX, ...args)
}

function error(...args) {
	console.error(LOG_PREFIX, ...args)
}

function info(...args) {
	console.info(LOG_PREFIX, ...args)
}

function time(label) {
	if (wantsVerboseOutput) console.time(`${LOG_PREFIX} ${label}`)
}

function timeEnd(label) {
	if (wantsVerboseOutput) console.timeEnd(`${LOG_PREFIX} ${label}`)
}

function spawnNodeProcess() {
	return cp.fork(`${__dirname}/prelude`, {
		stdio: "inherit",
	})
}

function handleNodeProcessExit(nodeProcess) {
	return () => {
		if (!nodeProcess) return

		const msg = ["Build process exited with"]
		if (nodeProcess.exitCode) {
			msg.push("status", nodeProcess.exitCode)
		} else {
			msg.push("signal", nodeProcess.signalCode)
		}

		;(nodeProcess.exitCode === 0 ? info : error)(...msg)
	}
}

function stopWatching() {
	if (watcher) {
		watcher.close()
	}
	if (watcherPromiseResolve) {
		watcherPromiseResolve()
	}
}

/** @type ts.FormatDiagnosticsHost */
const formatHost = {
	getCanonicalFileName: path => path,
	getCurrentDirectory: ts.sys.getCurrentDirectory,
	getNewLine: () => ts.sys.newLine,
}

async function watchMain() {
	nodeProcessStandby = spawnNodeProcess()

	const outDir = `${process.cwd()}/_build`
	if ((await fs.lstat(outDir)).isDirectory()) {
		await fs.rm(outDir, {
			recursive: true,
		})
	}

	const entrySrc = `${process.cwd()}/build/index.ts`
	const entryCompiled = `${outDir}/index.js`

	const configPath = ts.findConfigFile(
		process.cwd(),
		ts.sys.fileExists,
		"tsconfig.json"
	)
	if (!configPath) {
		throw new Error("Could not find a valid 'tsconfig.json'.")
	}

	// TypeScript can use several different program creation "strategies":
	//  * ts.createEmitAndSemanticDiagnosticsBuilderProgram,
	//  * ts.createSemanticDiagnosticsBuilderProgram
	//  * ts.createAbstractBuilder
	// The first two produce "builder programs". These use an incremental strategy
	// to only re-check and emit files whose contents may have changed, or whose
	// dependencies may have changes which may impact change the result of prior
	// type-check and emit.
	// The last uses an ordinary program which does a full type check after every
	// change.
	// Between `createEmitAndSemanticDiagnosticsBuilderProgram` and
	// `createSemanticDiagnosticsBuilderProgram`, the only difference is emit.
	// For pure type-checking scenarios, or when another tool/process handles emit,
	// using `createSemanticDiagnosticsBuilderProgram` may be more desirable.
	const createProgram = ts.createSemanticDiagnosticsBuilderProgram

	// Note that there is another overload for `createWatchCompilerHost` that takes
	// a set of root files.
	const host = ts.createWatchCompilerHost(
		configPath,
		{
			outDir: `${process.cwd()}/_build`,
		},
		{
			...ts.sys,
			writeFile(path, data, writeBOM) {
				filesEmittedInLastRun.add(path)
				ts.sys.writeFile(path, data, writeBOM)
			},
		},
		createProgram,
		reportDiagnostic,
		reportWatchStatusChanged
	)

	// You can technically override any given hook on the host, though you probably
	// don't need to.
	// Note that we're assuming `origCreateProgram` and `origPostProgramCreate`
	// doesn't use `this` at all.
	const origCreateProgram = host.createProgram
	host.createProgram = (_rootNames, options, host, oldProgram) => {
		time(COMPILE_TIMER_LABEL)
		hasDiagnostics = false

		if (nodeProcess) {
			nodeProcess.send({
				event: "buildscript-compile",
				data: "Compiling...",
			})
		}

		return origCreateProgram([entrySrc], options, host, oldProgram)
	}
	const origPostProgramCreate = host.afterProgramCreate

	host.afterProgramCreate = async program => {
		origPostProgramCreate(program)

		filesEmittedInLastRun.forEach(f =>
			filesEmittedInRunBeforeLastRun.delete(f)
		)
		const deleteFilesPromise = Promise.all(
			[...filesEmittedInRunBeforeLastRun].map(f => {
				debug("Unlinking", f)
				fs.unlink(f)
			})
		)
		filesEmittedInRunBeforeLastRun = filesEmittedInLastRun
		filesEmittedInLastRun = new Set()

		timeEnd(COMPILE_TIMER_LABEL)

		if (hasDiagnostics) {
			if (nodeProcess && nodeProcess.connected) {
				nodeProcess.send({
					event: "buildscript-failure",
					data: "Fail :<",
				})
			}
		} else {
			const exitPromise = (async () => {
				const np = nodeProcess
				if (!np || !np.connected) {
					return
				}
				np.removeListener("exit", handleNodeProcessExit(np))
				const politeExitPromise = new Promise(r => np.once("exit", r))
				np.kill("SIGUSR2")
				const hitTimeout = await Promise.race([
					politeExitPromise.then(() => false),
					new Promise(r => setTimeout(() => r(true), 5000)),
				])
				if (hitTimeout) {
					error(
						"Build process did not finish after polite exit signal - sending SIGKILL"
					)
					const killExitPromise = new Promise(r => np.once("exit", r))
					np.kill("SIGKILL")
					await killExitPromise
				}
			})()

			const np = nodeProcessStandby
			np.on("exit", handleNodeProcessExit(np))
			np.on("error", handleNodeProcessExit(np))
			nodeProcess = np
			await exitPromise
			np.send({
				event: "start",
				data: entryCompiled,
			})
			nodeProcessStandby = spawnNodeProcess()
		}

		await deleteFilesPromise
	}

	// `createWatchProgram` creates an initial program, watches files, and updates
	// the program over time.
	watcher = ts.createWatchProgram(host)
}

function reportDiagnostic(diagnostic) {
	hasDiagnostics = true
	error(
		"Error",
		diagnostic.code,
		":",
		ts.flattenDiagnosticMessageText(
			diagnostic.messageText,
			formatHost.getNewLine()
		)
	)
}

/**
 * Prints a diagnostic every time the watch status changes.
 * This is mainly for messages like "Starting compilation" or "Compilation completed".
 */
function reportWatchStatusChanged(diagnostic) {
	info(ts.formatDiagnostic(diagnostic, formatHost).trim())
}

;["SIGINT", "SIGTERM"].forEach(signal => {
	const listener = () => {
		killedBy = signal
		stopWatching()
		if (nodeProcess) {
			nodeProcess.kill(signal)
		}
		if (nodeProcessStandby) {
			nodeProcessStandby.kill()
		}
	}
	signalListeners.set(signal, listener)
	process.on(signal, listener)
})

watchMain()

function exit() {
	if (!killedBy) {
		throw new Error("Illegal state: exit without kill signal")
	}
	info("Exiting due to", killedBy)
	process.removeListener(killedBy, signalListeners.get(killedBy))
	process.kill(process.pid, killedBy)
}

/**
 * @param {cp.ChildProcess | undefined} nodeProcess
 */
function waitForNodeToExit(nodeProcess) {
	if (
		nodeProcess &&
		nodeProcess.exitCode === null &&
		nodeProcess.signalCode === null
	) {
		return new Promise(r => {
			nodeProcess.once("exit", r)
		})
	} else {
		return Promise.resolve()
	}
}

Promise.all([
	watcherPromise,
	waitForNodeToExit(nodeProcess),
	waitForNodeToExit(nodeProcessStandby),
]).finally(() => exit())
