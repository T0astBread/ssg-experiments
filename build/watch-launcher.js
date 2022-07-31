const cp = require("node:child_process");
const { ModuleKind } = require("typescript");
const ts = require("typescript");

let cleanup

/** @type ts.FormatDiagnosticsHost */
const formatHost = {
  getCanonicalFileName: path => path,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine
};

function watchMain() {
  const configPath = ts.findConfigFile(
    /*searchPath*/ "./",
    ts.sys.fileExists,
    "tsconfig.json"
  );
  if (!configPath) {
    throw new Error("Could not find a valid 'tsconfig.json'.");
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
  const createProgram = ts.createSemanticDiagnosticsBuilderProgram;

  // Note that there is another overload for `createWatchCompilerHost` that takes
  // a set of root files.
  const host = ts.createWatchCompilerHost(
    configPath,
    {
    },
    {
      ...ts.sys,
      writeFile(path, data, byteOrder) {
        console.log(path)
        delete require.cache[path]
        return ts.sys.writeFile(path, data, byteOrder)
      }
    },
    createProgram,
    reportDiagnostic,
    reportWatchStatusChanged
  );

  // You can technically override any given hook on the host, though you probably
  // don't need to.
  // Note that we're assuming `origCreateProgram` and `origPostProgramCreate`
  // doesn't use `this` at all.
  const origCreateProgram = host.createProgram;
  host.createProgram = (rootNames, options, host, oldProgram) => {
    const root = `${__dirname}/index.ts`
    console.log("** We're about to create the program! **");
    return origCreateProgram([root], options, host, oldProgram);
  };
  const origPostProgramCreate = host.afterProgramCreate;

  host.afterProgramCreate = program => {
    console.log("** We finished making the program! **");
    origPostProgramCreate(program);

    // program.getAllDependencies(program.getSourceFile(`${process.cwd()}/build/index.ts`))
    //   .filter(f => !f.startsWith(`${process.cwd()}/node_modules/`))
    //   .forEach(f => {
    //     delete require.cache[f]
    //   })

    if (cleanup) {
      cleanup()
    }
    const jsPath = `${__dirname}/index.js`
    // delete require.cache[jsPath]
    const mod = require(jsPath).default
    cleanup = mod()
  };

  // `createWatchProgram` creates an initial program, watches files, and updates
  // the program over time.
  ts.createWatchProgram(host);
}

function reportDiagnostic(diagnostic) {
  console.error("Error", diagnostic.code, ":", ts.flattenDiagnosticMessageText( diagnostic.messageText, formatHost.getNewLine()));
}

/**
 * Prints a diagnostic every time the watch status changes.
 * This is mainly for messages like "Starting compilation" or "Compilation completed".
 */
function reportWatchStatusChanged(diagnostic) {
  console.info(ts.formatDiagnostic(diagnostic, formatHost));
}

watchMain();