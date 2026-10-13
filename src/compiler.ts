import { fileURLToPath } from "node:url";
import { validateWebhookRoutes } from "./webhooks.js";
import { validateAppDeploymentConfiguration } from "./app-definition.js";
import { SLUG_PATTERN } from "./integration-protocol.js";
import ts from "typescript";
import path from "node:path";
import { createHash } from "node:crypto";
import { build, transform, type Plugin } from "esbuild";

const canonicalPath = (filename: string) => ts.sys.realpath?.(filename) ?? path.resolve(filename);

export class RuntimeContractError extends TypeError {
  constructor(message: string, readonly watchFiles: readonly string[]) { super(message); }
}

/** Fingerprint the App's structural contract without including sibling App source. */
function contractFingerprint(checker: ts.TypeChecker, types: readonly ts.Type[], location: ts.Node, program: ts.Program): string {
  const seen = new Map<ts.Type, number>();
  const primitive = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Void |
    ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never;
  const visit = (type: ts.Type): unknown => {
    if (type.isUnionOrIntersection()) return { kind: type.isUnion() ? "union" : "intersection", members: type.types.map(visit) };
    if (type.flags & primitive) return { flags: type.flags, name: checker.typeToString(type), ...(type.isLiteral() ? { value: type.value } : {}) };
    const previous = seen.get(type);
    if (previous !== undefined) return { ref: previous };
    const id = seen.size; seen.set(type, id);
    if (checker.isArrayType(type) || checker.isTupleType(type)) return { id, kind: checker.isTupleType(type) ? "tuple" : "array", name: checker.typeToString(type), elements: checker.getTypeArguments(type as ts.TypeReference).map(visit) };
    if (type.getSymbol()?.declarations?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))) return { id, libraryType: checker.typeToString(type, location, ts.TypeFormatFlags.NoTruncation) };
    return {
      id,
      properties: checker.getPropertiesOfType(type).sort((a, b) => a.name.localeCompare(b.name)).map(property => ({
        name: property.name, optional: !!(property.flags & ts.SymbolFlags.Optional), type: visit(checker.getTypeOfSymbolAtLocation(property, location)),
      })),
      indexes: checker.getIndexInfosOfType(type).map(index => ({ key: visit(index.keyType), value: visit(index.type), readonly: index.isReadonly })),
      calls: type.getCallSignatures().map(signature => ({ parameters: signature.parameters.map(parameter => visit(checker.getTypeOfSymbolAtLocation(parameter, location))), returns: visit(checker.getReturnTypeOfSignature(signature)) })),
    };
  };
  return JSON.stringify(types.map(visit));
}

/** Static definitions are split without importing or evaluating application code. */
export async function compileAppDefinitions(filename: string, compileOptions: { readonly webhooks?: boolean } = {}) {
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
  // Strict checking is a default only; an explicit project setting (including strict: false or checkJs) wins.
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, ...configured, noEmit: true, skipLibCheck: true, allowJs: true,
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
  if (!fileSymbol) return fail("Export at least one named App definition");
  const resolveSymbol = (symbol: ts.Symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const isSDKType = (symbol: ts.Symbol | undefined, name: string, module: string) => symbol?.declarations?.some(d =>
    ts.isClassDeclaration(d) && d.name?.text === name && canonicalPath(d.getSourceFile().fileName) === canonicalPath(fileURLToPath(new URL(`./${module}.d.ts`, import.meta.url))));
  const topStatement = (node: ts.Node): ts.Statement | undefined => {
    while (node.parent && node.parent !== file) node = node.parent;
    return node.parent === file ? node as ts.Statement : undefined;
  };
  const rejectDefinitionImport: Plugin = { name: "cantelop-definition-boundary", setup(builder) {
    const resolving = {};
    // Resolve before loading: esbuild can reuse the stdin module for an import
    // of its sourcefile, bypassing onLoad on platforms without path aliases.
    builder.onResolve({ filter: /.*/ }, async args => {
      if (args.pluginData === resolving) return;
      const resolved = await builder.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, pluginData: resolving });
      if (resolved.path && canonicalPath(resolved.path) === canonicalPath(filename)) {
        return { errors: [{ text: "Runtime and webhook dependencies cannot import their enclosing App definition; use the supplied context" }] };
      }
      // Let normal resolution preserve optional imports and package metadata.
    });
    builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, args => {
      if (canonicalPath(args.path) === canonicalPath(filename)) return { errors: [{ text: "Runtime and webhook dependencies cannot import their enclosing App definition; use the supplied context" }] };
    });
  } };
  const exports = checker.getExportsOfModule(fileSymbol);
  const appExports = new Set<ts.Symbol>();
  const aliasDeclarations = new Set<ts.VariableDeclaration>();
  const candidates = new Map<ts.Node, { declaration: ts.Declaration; expression: ts.Expression | undefined }>();
  for (const exported of exports) {
    const symbol = resolveSymbol(exported);
    if (!(symbol.flags & ts.SymbolFlags.Value) || !isSDKType(checker.getTypeOfSymbolAtLocation(symbol, file).getSymbol(), "App", "app")) continue;
    appExports.add(symbol);
    let declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    let expression = declaration && ts.isExportAssignment(declaration) ? declaration.expression
      : declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
    const seen = new Set<ts.Declaration>();
    while (expression && ts.isIdentifier(expression)) {
      if (declaration && ts.isVariableDeclaration(declaration)) {
        if (seen.has(declaration)) return fail("Circular App export alias");
        seen.add(declaration); aliasDeclarations.add(declaration);
      }
      const referenced = checker.getSymbolAtLocation(expression);
      declaration = referenced && resolveSymbol(referenced).valueDeclaration;
      expression = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
    }
    if (declaration) candidates.set(declaration, { declaration, expression });
  }
  if (!candidates.size) return fail("Export at least one App defined with cantelop.app({...})");
  const appStatements = new Set([...candidates.keys()].map(topStatement).filter((s): s is ts.Statement => !!s));
  const printer = ts.createPrinter();
  const print = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, file);
  const selectedSource = (selected: Set<ts.Statement>) => file.statements.filter(s => selected.has(s)).map(print).join("\n");
  const collect = (roots: readonly ts.Node[], sandbox: boolean) => {
    const selected = new Set<ts.Statement>();
    const visit = (node: ts.Node) => {
      if (ts.isTypeNode(node)) return;
      if (ts.isIdentifier(node)) {
        const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
        const typeSymbol = symbol && checker.getTypeOfSymbolAtLocation(symbol, node).getSymbol();
        if (sandbox && symbol?.declarations?.some(d => ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) && ts.isVariableStatement(d.parent.parent) && d.parent.parent.parent === file) &&
          (isSDKType(typeSymbol, "App", "app") || isSDKType(typeSymbol, "CantelopClient", "client"))) fail("App runtime or webhook cannot capture an App or CantelopClient instance");
        for (const d of symbol?.declarations ?? []) {
          if (d.getSourceFile() !== file) continue;
          const statement = topStatement(d);
          if (!statement || appStatements.has(statement) || selected.has(statement)) continue;
          selected.add(statement); visit(statement);
        }
      }
      ts.forEachChild(node, visit);
    };
    roots.forEach(visit); return selected;
  };
  const staticValue = (node: ts.Expression): unknown => {
    if (ts.isStringLiteral(node)) return node.text;
    // Imported const strings retain their literal type in package declarations.
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const type = checker.getTypeAtLocation(node);
      if (type.isStringLiteral()) return type.value;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, unknown> = Object.create(null);
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !property.name || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return fail("App deployment configuration must use literal values");
        result[property.name.text] = staticValue(property.initializer);
      }
      return result;
    }
    return fail("App deployment configuration must use literal values");
  };
  const backendStatements = collect([...aliasDeclarations].map(d => d.initializer!), false);
  for (const alias of aliasDeclarations) { const statement = topStatement(alias); if (statement) backendStatements.add(statement); }
  const allStatements = new Set<ts.Statement>([...backendStatements, ...appStatements]);
  const replacements = new Map<ts.Statement, string>();
  const names = new Set<string>();
  const apps = [];
  for (const candidate of candidates.values()) {
    const expression = candidate.expression;
    const statement = topStatement(candidate.declaration);
    if (!expression || !ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression) ||
        expression.expression.name.text !== "app" || !statement || candidate.declaration.getSourceFile() !== file ||
        !isSDKType(checker.getTypeAtLocation(expression.expression.expression).getSymbol(), "CantelopClient", "client")) {
      return fail("App definitions must call cantelop.app({...}) at module scope");
    }
    const argument = expression.arguments[0];
    if (!argument || !ts.isObjectLiteralExpression(argument) || argument.properties.some(p => ts.isSpreadAssignment(p))) return fail("App options must be a static object without spreads");
    const property = (name: string) => argument.properties.find(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
    const nameProperty = property("name");
    if (!nameProperty || !ts.isPropertyAssignment(nameProperty) || !ts.isStringLiteral(nameProperty.initializer)) return fail("App name must be a string literal");
    const name = nameProperty.initializer.text;
    if (!SLUG_PATTERN.test(name)) return fail("Invalid App name");
    if (names.has(name)) return fail(`Duplicate App name: ${name}`);
    names.add(name);
    const deployment: Record<string, unknown> = {};
    for (const key of ["environment", "dockerfile"]) {
      const option = property(key);
      if (option && ts.isPropertyAssignment(option)) deployment[key] = staticValue(option.initializer);
    }
    let configuration;
    try { configuration = validateAppDeploymentConfiguration(deployment); }
    catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
    const runtimeProperty = property("runtime");
    if (!runtimeProperty || !ts.isPropertyAssignment(runtimeProperty)) return fail("Define runtime directly in the App options");
    const runtime = runtimeProperty.initializer;
    // Factory calls remain Sandbox-only dependencies; the compiler never evaluates them.
    // Inspect their checked return type just as we inspect an inline handler object.
    const runtimeFactory = ts.isCallExpression(runtime);
    if (!runtimeFactory && (!ts.isObjectLiteralExpression(runtime) || runtime.properties.some(p => ts.isSpreadAssignment(p)))) return fail("App runtime must be an inline handler object without spreads or a typed runtime factory call");
    const runtimeKeys = runtimeFactory
      ? checker.getPropertiesOfType(checker.getTypeAtLocation(runtime)).map(p => p.name)
      : (runtime as ts.ObjectLiteralExpression).properties.map(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "");
    const harnessRuntime = runtimeKeys.includes("create");
    const allowedRuntimeKeys = harnessRuntime ? ["create", "onRecover", "redelivery"] : ["receive", "onActivate", "onRecover", "redelivery"];
    if (!runtimeKeys.includes(harnessRuntime ? "create" : "receive") || runtimeKeys.some(key => !allowedRuntimeKeys.includes(key))) return fail("Invalid Session runtime: define exactly one create or receive implementation");
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
    const webhookProperty = property("webhooks");
    const webhookExpression = webhookProperty && ts.isPropertyAssignment(webhookProperty) ? webhookProperty.initializer : undefined;
    if (webhookProperty && (!webhookExpression || !ts.isObjectLiteralExpression(webhookExpression))) fail("App webhooks must be an inline route object");
    const webhookRoutes: { path: string; method: "GET" | "POST" }[] = [];
    if (webhookExpression && ts.isObjectLiteralExpression(webhookExpression)) {
      for (const route of webhookExpression.properties) {
        if (!ts.isPropertyAssignment(route) || !ts.isStringLiteral(route.name) || !ts.isObjectLiteralExpression(route.initializer)) return fail("Webhook routes must use literal paths and inline options");
        const path = route.name.text;
        const fields = route.initializer.properties;
        if (fields.some(field => !field.name || !(ts.isIdentifier(field.name) || ts.isStringLiteral(field.name)) || !["method", "handle"].includes(field.name.text))) return fail("Invalid App webhook route");
        const methodField = fields.find(field => field.name && (ts.isIdentifier(field.name) || ts.isStringLiteral(field.name)) && field.name.text === "method");
        const handler = fields.find(field => field.name && (ts.isIdentifier(field.name) || ts.isStringLiteral(field.name)) && field.name.text === "handle");
        if (!methodField || !ts.isPropertyAssignment(methodField) || !ts.isStringLiteral(methodField.initializer) || !handler) return fail("Webhook routes require a literal method and handler");
        const method = methodField.initializer.text;
        try { validateWebhookRoutes({ [path]: { method: method as "GET" | "POST", handle: () => new Response() } }); }
        catch { return fail("Invalid App webhook route"); }
        webhookRoutes.push({ path, method: method as "GET" | "POST" });
      }
    }
    const homepageProperty = property("homepage");
    if (homepageProperty && !(ts.isMethodDeclaration(homepageProperty) || ts.isShorthandPropertyAssignment(homepageProperty) || ts.isPropertyAssignment(homepageProperty) &&
      (ts.isIdentifier(homepageProperty.initializer) || ts.isArrowFunction(homepageProperty.initializer) || ts.isFunctionExpression(homepageProperty.initializer)))) fail("App homepage must be an inline or imported handler");
    const webhookStatements = collect([...(webhookExpression ? [webhookExpression] : []), ...(homepageProperty ? [homepageProperty] : [])], true);
    for (const dependency of webhookStatements) allStatements.add(dependency);
    const webhookSource = selectedSource(webhookStatements) + "\nexport default { webhooks: " + (webhookExpression ? print(webhookExpression) : "{}") + (homepageProperty ? ", " + print(homepageProperty) : "") + " };\n";
    // Only Edge artifacts consume the webhook bundle; backend and Sandbox builds skip it.
    let webhookModule = "";
    if (compileOptions.webhooks !== false) {
      const webhookBundle = await build({ stdin: { contents: webhookSource, resolveDir: path.dirname(filename), sourcefile: filename, loader: "ts" }, bundle: true, platform: "browser", format: "esm", target: "es2022", write: false, metafile: true, logLevel: "silent", plugins: [rejectDefinitionImport] });
      webhookModule = webhookBundle.outputFiles![0]!.text;
      for (const input of Object.keys(webhookBundle.metafile?.inputs ?? {})) if (!input.startsWith("<")) watchFiles.push(path.resolve(input));
    }
    const authProperty = property("auth");
    if (authProperty && !(ts.isPropertyAssignment(authProperty) || ts.isShorthandPropertyAssignment(authProperty))) fail("App auth must be an inline or imported provider");
    const authExpression = authProperty && (ts.isShorthandPropertyAssignment(authProperty) ? authProperty.name : ts.isPropertyAssignment(authProperty) ? authProperty.initializer : undefined);
    // Auth runs only in the Sandbox, beside the runtime; its dependencies never reach backend or Edge builds.
    const runtimeStatements = collect([runtime, ...(authProperty ? [authProperty] : [])], true);
    for (const dependency of runtimeStatements) allStatements.add(dependency);
    for (const dependency of collect([expression.expression, ...argument.properties.filter(p => p !== runtimeProperty && p !== webhookProperty && p !== homepageProperty && p !== authProperty)], false)) {
      backendStatements.add(dependency); allStatements.add(dependency);
    }
    const runtimeSource = selectedSource(runtimeStatements) + "\nexport default " + print(runtime) + ";\n" + (authExpression ? "export const auth = " + print(authExpression) + ";\n" : "");
    const bundle = await build({ stdin: { contents: runtimeSource, resolveDir: path.dirname(filename), sourcefile: filename, loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "esnext", conditions: ["bun", "node", "import", "default"], external: ["bun:*"], write: false, metafile: true, minify: false, logLevel: "silent", plugins: [rejectDefinitionImport] });
    const runtimeModule = bundle.outputFiles![0]!.text;
    for (const input of Object.keys(bundle.metafile?.inputs ?? {})) if (!input.startsWith("<")) watchFiles.push(path.resolve(input));
    const contract = contractFingerprint(checker, checker.getTypeArguments(checker.getTypeAtLocation(expression) as ts.TypeReference), expression, program);
    const id = "rt_" + createHash("sha256").update(name).update((await transform(runtimeModule, { minify: true, legalComments: "none", target: "esnext" })).code).update(contract).update(JSON.stringify(configuration)).digest("hex");
    const replacement = `{receive() { throw new Error("App runtime executes in the Sandbox"); }, [Symbol.for("dev.cantelop.sdk.compiled-runtime.v1")]: ${JSON.stringify(id)}}`;
    const statementText = statement.getText(file);
    const dockerfileProperty = property("dockerfile");
    const edits = [{ node: runtime, text: replacement },
      ...(dockerfileProperty && ts.isPropertyAssignment(dockerfileProperty) ? [{ node: dockerfileProperty.initializer, text: JSON.stringify(configuration.dockerfile) }] : []), ...(webhookExpression ? [{ node: webhookExpression, text: "{}" }] : []), ...(homepageProperty ? [{ node: homepageProperty, text: "homepage: undefined" }] : []),
      ...(authProperty ? [{ node: authProperty, text: `auth: {[Symbol.for("dev.cantelop.sdk.compiled-auth.v1")]: true}` }] : [])];
    let backendStatement = statementText;
    for (const edit of edits.sort((a, b) => b.node.getStart(file) - a.node.getStart(file))) {
      const start = edit.node.getStart(file) - statement.getStart(file);
      backendStatement = backendStatement.slice(0, start) + edit.text + backendStatement.slice(edit.node.end - statement.getStart(file));
    }
    replacements.set(statement, backendStatement);
    apps.push({ definition: { id, name, ...configuration, ...(authProperty ? { auth: true as const } : {}) }, entrypoint: filename, runtimeModule, webhookModule, webhookRoutes, hasHomepage: !!homepageProperty });
  }
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause || ts.isExpressionStatement(statement)) fail("App definitions cannot contain top-level side effects; move them into a runtime dependency");
    if ((ts.isVariableStatement(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && !allStatements.has(statement)) fail("Unreferenced declarations in the definition are ambiguous; move them into a dependency module");
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length !== 1) fail("Use one top-level declaration per statement in App definitions");
  }
  for (const exported of exports) {
    const symbol = resolveSymbol(exported);
    if (!appExports.has(symbol) && (symbol.flags & ts.SymbolFlags.Value) && !isSDKType(checker.getTypeOfSymbolAtLocation(symbol, file).getSymbol(), "CantelopClient", "client")) fail("Definition modules may only export Apps and their client; put other values in dependency modules");
  }
  const backendSource = file.statements.filter(s => backendStatements.has(s) || appStatements.has(s) || ts.isExportAssignment(s) || ts.isExportDeclaration(s))
    .map(s => replacements.get(s) ?? print(s)).join("\n");
  return { apps, backendSource, emitBackendDeclarations: () => emitBackendDeclarations(filename, options), watchFiles: [...new Set(watchFiles)] };
}

/** Select an App for an Edge/Sandbox artifact; multiple Apps require an explicit name. */
export async function compileClientDefinition(filename: string, app?: string, options: { readonly webhooks?: boolean } = {}) {
  const result = await compileAppDefinitions(filename, options);
  const selected = app === undefined && result.apps.length === 1 ? result.apps[0] : result.apps.find(value => value.definition.name === app);
  if (!selected) throw new RuntimeContractError(app === undefined ? "Multiple Apps: select an App by name" : `App not found: ${app}`, result.watchFiles);
  return { ...selected, backendSource: result.backendSource, watchFiles: result.watchFiles };
}

/** Use in the application's backend esbuild pipeline to exclude all Sandbox dependencies. */
export function createCantelopCompilerPlugin(options: { readonly definition: string }): Plugin {
  const definition = canonicalPath(path.resolve(options.definition));
  return { name: "cantelop-app-compiler", setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, async args => {
      if (canonicalPath(args.path) !== definition) return;
      try {
        const compiled = await compileAppDefinitions(definition, { webhooks: false });
        return { contents: compiled.backendSource, loader: "ts", resolveDir: path.dirname(definition), watchFiles: compiled.watchFiles };
      } catch (error) {
        return { errors: [{ text: error instanceof Error ? error.message : String(error) }], watchFiles: error instanceof RuntimeContractError ? [...error.watchFiles] : [definition] };
      }
    });
  } };
}

/** Emit a portable declaration graph without evaluating the definition or its dependencies. */
function emitBackendDeclarations(filename: string, options: ts.CompilerOptions): ReadonlyMap<string, string> {
  const declarationOptions: ts.CompilerOptions = { ...options, noEmit: false, declaration: true,
    emitDeclarationOnly: true, declarationMap: false, sourceMap: false, incremental: false, composite: false };
  delete declarationOptions.outFile;
  delete declarationOptions.tsBuildInfoFile;
  const declarations = new Map<string, { text: string; extension: string }>();
  const host = ts.createCompilerHost(declarationOptions);
  host.writeFile = (output, text, _bom, _error, sources) => {
    const source = sources?.[0];
    if (source) declarations.set(canonicalPath(source.fileName), { text, extension: output.endsWith(".d.mts") ? ".d.mts" : output.endsWith(".d.cts") ? ".d.cts" : ".d.ts" });
  };
  const declarationProgram = ts.createProgram([filename], declarationOptions, host);
  const sourceFiles = new Map(declarationProgram.getSourceFiles().map(source => [canonicalPath(source.fileName), source]));
  const files = new Map<string, string>();
  const targets = new Map<string, string>([[canonicalPath(filename), "client.d.mts"]]);
  const visit = (source: string): string => {
    source = canonicalPath(source);
    const existing = targets.get(source);
    const sourceFile = sourceFiles.get(source);
    if (sourceFile && !sourceFile.isDeclarationFile && !declarations.has(source)) {
      // Emit only reachable contracts; unrelated native declarations cannot break the backend build.
      const result = declarationProgram.emit(sourceFile, host.writeFile, undefined, true);
      if (result.emitSkipped || result.diagnostics.length) {
        throw new RuntimeContractError("Cannot emit backend client declarations:\n" + ts.formatDiagnostics(result.diagnostics, {
          getCurrentDirectory: () => path.dirname(filename), getCanonicalFileName: f => f, getNewLine: () => "\n",
        }), [filename, source]);
      }
    }
    const declaration = declarations.get(source);
    // Local handwritten declarations also need to travel with the artifact.
    const text = declaration?.text ?? (sourceFile?.isDeclarationFile ? sourceFile.text : undefined);
    if (text === undefined) throw new RuntimeContractError(`Missing declaration for ${source}`, [filename, source]);
    const target = existing ?? `types/module-${targets.size}${declaration?.extension ?? (source.endsWith(".d.mts") ? ".d.mts" : source.endsWith(".d.cts") ? ".d.cts" : ".d.ts")}`;
    targets.set(source, target);
    // Reserve before walking imports to handle circular protocol types.
    if (files.has(target)) return target;
    files.set(target, "");
    const parsed = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true);
    const edits: { start: number; end: number; text: string }[] = [];
    const walk = (node: ts.Node) => {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal
        : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression : undefined;
      if (specifier && ts.isStringLiteral(specifier)) {
        const resolved = ts.resolveModuleName(specifier.text, source, options, ts.sys).resolvedModule;
        if (resolved && !resolved.isExternalLibraryImport && sourceFiles.has(canonicalPath(resolved.resolvedFileName))) {
          const dependency = visit(resolved.resolvedFileName);
          let relative = path.posix.relative(path.posix.dirname(target), dependency).replace(/\.d\.(mts|cts|ts)$/, (_, extension: string) => extension === "mts" ? ".mjs" : extension === "cts" ? ".cjs" : ".js");
          if (!relative.startsWith(".")) relative = "./" + relative;
          edits.push({ start: specifier.getStart(parsed), end: specifier.end, text: JSON.stringify(relative) });
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(parsed);
    let rewritten = text;
    for (const edit of edits.sort((a, b) => b.start - a.start)) rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
    files.set(target, rewritten);
    return target;
  };
  visit(filename);
  return files;
}
