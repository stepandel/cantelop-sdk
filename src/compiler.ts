import ts from "typescript";
import path from "node:path";
import { createHash } from "node:crypto";
import { build, transform, type Plugin } from "esbuild";

export class RuntimeContractError extends TypeError {
  constructor(message: string, readonly watchFiles: readonly string[]) { super(message); }
}

/** Static definitions are split without importing or evaluating application code. */
export async function compileClientDefinition(filename: string) {
  filename = path.resolve(filename);
  const configPath = ts.findConfigFile(path.dirname(filename), ts.sys.fileExists);
  let configured: ts.CompilerOptions = {};
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new RuntimeContractError(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"), [filename, configPath]);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    if (parsed.errors.length) throw new RuntimeContractError(ts.flattenDiagnosticMessageText(parsed.errors[0]!.messageText, "\n"), [filename, configPath]);
    configured = parsed.options;
  }
  delete configured.rootDir;
  delete configured.outDir;
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    ...configured, noEmit: true, strict: true, skipLibCheck: true, allowJs: true, checkJs: true,
    noImplicitAny: configured.noImplicitAny ?? Boolean(configured.strict), allowImportingTsExtensions: true };
  const program = ts.createProgram([filename], options);
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(filename);
  const watchFiles = program.getSourceFiles().filter(f => !program.isSourceFileFromExternalLibrary(f) && !program.isSourceFileDefaultLibrary(f)).map(f => f.fileName);
  if (configPath) watchFiles.push(configPath);
  for (const source of program.getSourceFiles()) {
    if (!watchFiles.includes(source.fileName)) continue;
    for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith(".")) {
      const imported = path.resolve(path.dirname(source.fileName), statement.moduleSpecifier.text);
      watchFiles.push(imported);
      if (/\.[cm]?js$/.test(imported)) watchFiles.push(imported.replace(/js$/, "ts"));
      else if (!path.extname(imported)) watchFiles.push(imported + ".ts", path.join(imported, "index.ts"));
    }
  }
  const fail = (message: string): never => { throw new RuntimeContractError(message, watchFiles); };
  if (!file) return fail("Client definition does not exist");
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) fail("Invalid Session runtime:\n" + ts.formatDiagnostics(diagnostics.slice(0, 10), { getCurrentDirectory: () => path.dirname(filename), getCanonicalFileName: f => f, getNewLine: () => "\n" }));
  const fileSymbol = checker.getSymbolAtLocation(file);
  if (!fileSymbol) return fail("Default export must be a CantelopClient definition");
  const exported = checker.getExportsOfModule(fileSymbol).find(s => s.name === "default");
  const declaration = exported?.declarations?.[0];
  let expression: ts.Expression | undefined = declaration && ts.isExportAssignment(declaration) ? declaration.expression : undefined;
  let clientSymbol: ts.Symbol | undefined;
  let clientStatement: ts.Statement | undefined;
  const topStatement = (node: ts.Node): ts.Statement | undefined => {
    while (node.parent && node.parent !== file) node = node.parent;
    return node.parent === file ? node as ts.Statement : undefined;
  };
  if (expression && ts.isIdentifier(expression)) {
    clientSymbol = checker.getSymbolAtLocation(expression);
    const value = clientSymbol?.valueDeclaration;
    if (value && ts.isVariableDeclaration(value)) { clientStatement = topStatement(value); expression = value.initializer; }
  } else if (expression) clientStatement = topStatement(expression);
  if (!expression || !ts.isNewExpression(expression) || !clientStatement) return fail("Default export must be a top-level new CantelopClient({...}) definition");
  const constructor = checker.getSymbolAtLocation(expression.expression);
  const target = constructor && (constructor.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(constructor) : constructor);
  if (!target?.declarations?.some(d => ts.isClassDeclaration(d) && d.name?.text === "CantelopClient" && /[/\\]client\.(?:ts|d\.ts)$/.test(d.getSourceFile().fileName))) return fail("Default export must instantiate the SDK CantelopClient");
  const argument = expression.arguments?.[0];
  if (!argument || !ts.isObjectLiteralExpression(argument) || argument.properties.some(p => ts.isSpreadAssignment(p))) return fail("Client options must be a static object without spreads");
  const runtimeProperty = argument.properties.find(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === "sessionRuntime");
  if (!runtimeProperty || !ts.isPropertyAssignment(runtimeProperty)) return fail("Define sessionRuntime directly in the client options");
  const runtime = runtimeProperty.initializer;
  if (!ts.isObjectLiteralExpression(runtime) || runtime.properties.some(p => ts.isSpreadAssignment(p))) return fail("sessionRuntime must be an inline handler object without spreads");
  const contextual = checker.getContextualType(runtime);
  if (contextual) for (const property of checker.getPropertiesOfType(contextual)) {
    const actual = checker.getPropertyOfType(checker.getTypeAtLocation(runtime), property.name);
    if (!actual) continue;
    const expectedType = checker.getTypeOfSymbolAtLocation(property, runtime);
    const actualType = checker.getTypeOfSymbolAtLocation(actual, runtime);
    const expectedSignature = checker.getNonNullableType(expectedType).getCallSignatures()[0];
    const actualSignature = checker.getNonNullableType(actualType).getCallSignatures()[0];
    if (expectedSignature && actualSignature) expectedSignature.parameters.forEach((parameter, index) => {
      const actualParameter = actualSignature.parameters[index];
      if (actualParameter && !checker.isTypeAssignableTo(checker.getTypeOfSymbolAtLocation(parameter, runtime), checker.getTypeOfSymbolAtLocation(actualParameter, runtime))) fail(`Invalid Session runtime ${property.name} parameter`);
    });
  }
  const collect = (roots: readonly ts.Node[], sandbox: boolean) => {
    const selected = new Set<ts.Statement>();
    const visit = (node: ts.Node) => {
      if (ts.isTypeNode(node)) return;
      if (ts.isIdentifier(node)) {
        const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
        if (sandbox && symbol && symbol === clientSymbol) fail("Session runtime cannot capture its CantelopClient instance");
        for (const d of symbol?.declarations ?? []) {
          if (d.getSourceFile() !== file) continue;
          const statement = topStatement(d);
          if (!statement || statement === clientStatement || selected.has(statement)) continue;
          selected.add(statement); visit(statement);
        }
      }
      ts.forEachChild(node, visit);
    };
    roots.forEach(visit);
    return selected;
  };
  const sandboxStatements = collect([runtime], true);
  const backendStatements = collect([expression.expression, ...argument.properties.filter(p => p !== runtimeProperty)], false);
  // Side effects must be owned by a referenced module; the definition itself is declarative.
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause || ts.isExpressionStatement(statement)) fail("Client definitions cannot contain top-level side effects; move them into a runtime dependency");
    if ((ts.isVariableStatement(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement !== clientStatement && !sandboxStatements.has(statement) && !backendStatements.has(statement)) fail("Unreferenced declarations in the client definition are ambiguous; move them into a dependency module");
  }
  for (const statement of file.statements) if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length !== 1) fail("Use one top-level declaration per statement in client definitions");
  for (const symbol of checker.getExportsOfModule(fileSymbol)) {
    if (symbol.name !== "default" && symbol !== clientSymbol && (symbol.flags & ts.SymbolFlags.Value)) fail("Client definitions may only export their CantelopClient instance; put other values in dependency modules");
  }
  const printer = ts.createPrinter();
  const print = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, file);
  const selectedSource = (selected: Set<ts.Statement>) => file.statements.filter(s => selected.has(s)).map(print).join("\n");
  const runtimeSource = selectedSource(sandboxStatements) + "\nexport default " + print(runtime) + ";\n";
  const bundle = await build({ stdin: { contents: runtimeSource, resolveDir: path.dirname(filename), sourcefile: filename, loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "esnext", conditions: ["bun", "node", "import", "default"], external: ["bun:*"], write: false, metafile: true, minify: false, logLevel: "silent" });
  const runtimeModule = bundle.outputFiles![0]!.text;
  for (const input of Object.keys(bundle.metafile?.inputs ?? {})) if (!input.startsWith("<")) watchFiles.push(path.resolve(input));
  // Include checked contracts and source graph so type-only changes invalidate identity too.
  const projectDirectory = configPath ? path.dirname(configPath) : path.dirname(filename);
  const contract = program.getSourceFiles().filter(f => f.fileName.startsWith(projectDirectory + path.sep) && !f.fileName.includes("node_modules")).map(f => [path.relative(path.dirname(filename), f.fileName), f.text]);
  const id = "rt_" + createHash("sha256").update((await transform(runtimeModule, { minify: true, legalComments: "none", target: "esnext" })).code).update(JSON.stringify(contract)).digest("hex");
  const replacement = `{receive() { throw new Error("Session runtime executes in the Sandbox"); }, [Symbol.for("dev.cantelop.sdk.compiled-runtime.v1")]: ${JSON.stringify(id)}}`;
  const statementText = clientStatement.getText(file);
  const start = runtime.getStart(file) - clientStatement.getStart(file);
  const rewritten = statementText.slice(0, start) + replacement + statementText.slice(runtime.end - clientStatement.getStart(file));
  const backendSource = selectedSource(backendStatements) + "\n" + rewritten + "\n" + (declaration && (declaration as ts.Node) !== clientStatement && ts.isExportAssignment(declaration) ? print(declaration) : "");
  return { definition: { id }, entrypoint: filename, runtimeModule, backendSource, watchFiles: [...new Set(watchFiles)] };
}

/** Use in the application's backend esbuild pipeline to exclude Sandbox dependencies. */
export function createCantelopCompilerPlugin(options: { readonly definition: string }): Plugin {
  const definition = path.resolve(options.definition);
  return { name: "cantelop-client-compiler", setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, async args => {
      if (path.resolve(args.path) !== definition) return;
      try {
        const compiled = await compileClientDefinition(definition);
        return { contents: compiled.backendSource, loader: "ts", resolveDir: path.dirname(definition), watchFiles: compiled.watchFiles };
      } catch (error) {
        return { errors: [{ text: error instanceof Error ? error.message : String(error) }], watchFiles: error instanceof RuntimeContractError ? [...error.watchFiles] : [definition] };
      }
    });
  } };
}
