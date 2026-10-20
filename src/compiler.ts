import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { build, transform, type Plugin } from "esbuild";
import { isValidWebhookRoute } from "./webhooks.js";
import { validateAppDeploymentConfiguration } from "./app-definition.js";
import { SLUG_PATTERN } from "./integration-protocol.js";
import { RUNTIME_ID } from "./session-runtime-contract.js";
import { COMPILED_AUTH } from "./native-auth.js";

const canonicalPath = (filename: string) => ts.sys.realpath?.(filename) ?? path.resolve(filename);

export class RuntimeContractError extends TypeError {
  constructor(message: string, readonly watchFiles: readonly string[]) { super(message); }
}

/**
 * Fingerprint the App's structural contract without including sibling App source.
 * Never print a type that can contain user types: TypeScript names a type it cannot
 * reach from a location as import("<absolute path>"), which would tie the ID to the checkout.
 */
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
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const tuple = checker.isTupleType(type) ? (type as ts.TypeReference).target as ts.TupleType : undefined;
      return { id, kind: tuple ? "tuple" : "array", readonly: tuple ? tuple.readonly : type.getSymbol()?.name === "ReadonlyArray", ...(tuple ? { elementFlags: tuple.elementFlags } : {}), elements: checker.getTypeArguments(type as ts.TypeReference).map(visit) };
    }
    // Library types are identified by name, with their type arguments visited. Library mapped
    // types such as Partial<T> have an anonymous symbol and resolve to properties below.
    const symbol = type.getSymbol();
    if (symbol && !(symbol.flags & ts.SymbolFlags.TypeLiteral) && symbol.declarations?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))) {
      const reference = type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference;
      return { id, libraryType: checker.getFullyQualifiedName(symbol), typeArguments: reference ? checker.getTypeArguments(type as ts.TypeReference).map(visit) : [] };
    }
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

const EMIT_ONLY_OPTIONS = ["noEmit", "declaration", "emitDeclarationOnly", "declarationMap", "sourceMap", "incremental", "composite", "outFile", "tsBuildInfoFile"] as const;
/**
 * Parsed (and bound) files shared by every program this process creates: watch rebuilds and
 * declaration emit re-parse only files whose text or parse settings changed, as tsc --watch does.
 */
const sourceFileCache = new Map<string, { readonly key: string; readonly text: string; readonly file: ts.SourceFile }>();
/** The last program per definition, passed as oldProgram so unchanged structure and resolution are reused. */
const previousPrograms = new Map<string, ts.Program>();

function cachingCompilerHost(options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const parse = host.getSourceFile.bind(host);
  const settings: Record<string, unknown> = { ...options };
  for (const name of EMIT_ONLY_OPTIONS) delete settings[name];
  const settingsKey = JSON.stringify(settings);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    const text = shouldCreateNewSourceFile ? undefined : host.readFile(fileName);
    if (text === undefined) return parse(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    const parsing = typeof languageVersionOrOptions === "object" ? languageVersionOrOptions : { languageVersion: languageVersionOrOptions };
    const key = `${parsing.languageVersion}:${parsing.impliedNodeFormat}:${parsing.jsDocParsingMode}:${settingsKey}`;
    const cached = sourceFileCache.get(fileName);
    if (cached?.key === key && cached.text === text) return cached.file;
    const file = ts.createSourceFile(fileName, text, languageVersionOrOptions);
    sourceFileCache.set(fileName, { key, text, file });
    return file;
  };
  return host;
}

/** The project's compiler options with the defaults and overrides definition analysis requires. */
function definitionCompilerOptions(filename: string): { readonly options: ts.CompilerOptions; readonly configPath?: string } {
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
  return configPath ? { options, configPath } : { options };
}

/** Local sources (and the relative imports they name, even when missing) so watch mode notices new files. */
function definitionWatchFiles(program: ts.Program, configPath: string | undefined): Set<string> {
  const watchFiles = new Set(program.getSourceFiles().filter(f => !program.isSourceFileFromExternalLibrary(f) && !program.isSourceFileDefaultLibrary(f)).map(f => f.fileName));
  if (configPath) watchFiles.add(configPath);
  for (const source of program.getSourceFiles()) {
    if (!watchFiles.has(source.fileName)) continue;
    for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith(".")) {
      const imported = path.resolve(path.dirname(source.fileName), statement.moduleSpecifier.text);
      watchFiles.add(imported);
      if (/\.[cm]?js$/.test(imported)) watchFiles.add(imported.replace(/js$/, "ts"));
      else if (!path.extname(imported)) { watchFiles.add(imported + ".ts"); watchFiles.add(path.join(imported, "index.ts")); }
    }
  }
  return watchFiles;
}

/** The literal key of an object member, when it has one. */
function propertyName(element: ts.ObjectLiteralElementLike): string | undefined {
  const name = ts.isSpreadAssignment(element) ? undefined : element.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

/** Source text that evaluates to a registered SDK marker symbol. */
function symbolSource(symbol: symbol): string {
  return `Symbol.for(${JSON.stringify(Symbol.keyFor(symbol))})`;
}

const SDK_DECLARATIONS = {
  app: canonicalPath(fileURLToPath(new URL("./app.d.ts", import.meta.url))),
  client: canonicalPath(fileURLToPath(new URL("./client.d.ts", import.meta.url))),
} as const;

/** True only for the SDK's own App/CantelopClient classes, not look-alikes with the same names. */
function isSDKType(symbol: ts.Symbol | undefined, name: "App" | "CantelopClient"): boolean {
  const declarationFile = name === "App" ? SDK_DECLARATIONS.app : SDK_DECLARATIONS.client;
  return symbol?.declarations?.some(d => ts.isClassDeclaration(d) && d.name?.text === name && canonicalPath(d.getSourceFile().fileName) === declarationFile) ?? false;
}

/** Runtime and webhook bundles must not import the definition that encloses them. */
function definitionBoundaryPlugin(filename: string): Plugin {
  const message = "Runtime and webhook dependencies cannot import their enclosing App definition; use the supplied context";
  return { name: "cantelop-definition-boundary", setup(builder) {
    const resolving = {};
    // Resolve before loading: esbuild can reuse the stdin module for an import
    // of its sourcefile, bypassing onLoad on platforms without path aliases.
    builder.onResolve({ filter: /.*/ }, async args => {
      if (args.pluginData === resolving) return;
      const resolved = await builder.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, pluginData: resolving });
      if (resolved.path && canonicalPath(resolved.path) === canonicalPath(filename)) return { errors: [{ text: message }] };
      // Let normal resolution preserve optional imports and package metadata.
    });
    builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, args => {
      if (canonicalPath(args.path) === canonicalPath(filename)) return { errors: [{ text: message }] };
    });
  } };
}

interface AppCandidate { readonly declaration: ts.Declaration; readonly expression: ts.Expression | undefined }

/** One checked definition module and the state shared while its Apps are extracted. */
class DefinitionModule {
  readonly checker: ts.TypeChecker;
  readonly #printer = ts.createPrinter();
  readonly boundary: Plugin;
  /** Top-level statements that construct Apps; never pulled in as another statement's dependency. */
  appStatements = new Set<ts.Statement>();

  constructor(readonly filename: string, readonly program: ts.Program, readonly file: ts.SourceFile, readonly watchFiles: Set<string>) {
    this.checker = program.getTypeChecker();
    this.boundary = definitionBoundaryPlugin(filename);
  }

  fail(message: string): never { throw new RuntimeContractError(message, [...this.watchFiles]); }
  print(node: ts.Node): string { return this.#printer.printNode(ts.EmitHint.Unspecified, node, this.file); }
  selectedSource(selected: ReadonlySet<ts.Statement>): string { return this.file.statements.filter(s => selected.has(s)).map(s => this.print(s)).join("\n"); }
  resolveSymbol(symbol: ts.Symbol): ts.Symbol { return symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol; }
  valueType(symbol: ts.Symbol): ts.Symbol | undefined { return this.checker.getTypeOfSymbolAtLocation(symbol, this.file).getSymbol(); }

  topStatement(node: ts.Node): ts.Statement | undefined {
    while (node.parent && node.parent !== this.file) node = node.parent;
    return node.parent === this.file ? node as ts.Statement : undefined;
  }

  /** Top-level statements the roots depend on. Sandbox code may not capture an App or client instance. */
  collect(roots: readonly ts.Node[], sandbox: boolean): Set<ts.Statement> {
    const { checker, file } = this;
    const selected = new Set<ts.Statement>();
    const visit = (node: ts.Node) => {
      if (ts.isTypeNode(node)) return;
      if (ts.isIdentifier(node)) {
        const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
        const typeSymbol = symbol && checker.getTypeOfSymbolAtLocation(symbol, node).getSymbol();
        if (sandbox && symbol?.declarations?.some(d => ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) && ts.isVariableStatement(d.parent.parent) && d.parent.parent.parent === file) &&
          (isSDKType(typeSymbol, "App") || isSDKType(typeSymbol, "CantelopClient"))) this.fail("App runtime or webhook cannot capture an App or CantelopClient instance");
        for (const d of symbol?.declarations ?? []) {
          if (d.getSourceFile() !== file) continue;
          const statement = this.topStatement(d);
          if (!statement || this.appStatements.has(statement) || selected.has(statement)) continue;
          selected.add(statement); visit(statement);
        }
      }
      ts.forEachChild(node, visit);
    };
    roots.forEach(visit);
    return selected;
  }

  /** A literal deployment value; the compiler never evaluates definition code. */
  staticValue(node: ts.Expression): unknown {
    if (ts.isStringLiteral(node)) return node.text;
    // Imported const strings retain their literal type in package declarations.
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const type = this.checker.getTypeAtLocation(node);
      if (type.isStringLiteral()) return type.value;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, unknown> = Object.create(null);
      for (const property of node.properties) {
        const name = propertyName(property);
        if (!ts.isPropertyAssignment(property) || name === undefined) return this.fail("App deployment configuration must use literal values");
        result[name] = this.staticValue(property.initializer);
      }
      return result;
    }
    return this.fail("App deployment configuration must use literal values");
  }

  /** Exported SDK Apps, following `export const x = y` aliases back to their `cantelop.app(...)` call. */
  discoverApps(exports: readonly ts.Symbol[]) {
    const appExports = new Set<ts.Symbol>();
    const aliasDeclarations = new Set<ts.VariableDeclaration>();
    const candidates = new Map<ts.Node, AppCandidate>();
    for (const exported of exports) {
      const symbol = this.resolveSymbol(exported);
      if (!(symbol.flags & ts.SymbolFlags.Value) || !isSDKType(this.valueType(symbol), "App")) continue;
      appExports.add(symbol);
      let declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      let expression = declaration && ts.isExportAssignment(declaration) ? declaration.expression
        : declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
      const seen = new Set<ts.Declaration>();
      while (expression && ts.isIdentifier(expression)) {
        if (declaration && ts.isVariableDeclaration(declaration)) {
          if (seen.has(declaration)) return this.fail("Circular App export alias");
          seen.add(declaration); aliasDeclarations.add(declaration);
        }
        const referenced = this.checker.getSymbolAtLocation(expression);
        declaration = referenced && this.resolveSymbol(referenced).valueDeclaration;
        expression = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
      }
      if (declaration) candidates.set(declaration, { declaration, expression });
    }
    return { appExports, aliasDeclarations, candidates };
  }

  /** Definition modules hold only App declarations and their static dependencies. */
  assertModuleShape(exports: readonly ts.Symbol[], appExports: ReadonlySet<ts.Symbol>, referenced: ReadonlySet<ts.Statement>): void {
    for (const statement of this.file.statements) {
      if (ts.isImportDeclaration(statement) && !statement.importClause || ts.isExpressionStatement(statement)) this.fail("App definitions cannot contain top-level side effects; move them into a runtime dependency");
      if ((ts.isVariableStatement(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && !referenced.has(statement)) this.fail("Unreferenced declarations in the definition are ambiguous; move them into a dependency module");
      if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length !== 1) this.fail("Use one top-level declaration per statement in App definitions");
    }
    for (const exported of exports) {
      const symbol = this.resolveSymbol(exported);
      if (!appExports.has(symbol) && (symbol.flags & ts.SymbolFlags.Value) && !isSDKType(this.valueType(symbol), "CantelopClient")) this.fail("Definition modules may only export Apps and their client; put other values in dependency modules");
    }
  }
}

/** Shared bookkeeping across the Apps of one definition module. */
interface ExtractionState {
  readonly appName?: string;
  readonly webhooks: boolean;
  readonly names: Set<string>;
  readonly backendStatements: Set<ts.Statement>;
  readonly allStatements: Set<ts.Statement>;
}

/** Split one `cantelop.app({...})` call into Sandbox, Edge and backend parts and derive its identity. */
async function extractApp(module: DefinitionModule, candidate: AppCandidate, state: ExtractionState) {
  const { checker, file, filename, watchFiles } = module;
  const fail = (message: string): never => module.fail(message);
  const expression = candidate.expression;
  const statement = module.topStatement(candidate.declaration);
  if (!expression || !ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression) ||
      expression.expression.name.text !== "app" || !statement || candidate.declaration.getSourceFile() !== file ||
      !isSDKType(checker.getTypeAtLocation(expression.expression.expression).getSymbol(), "CantelopClient")) {
    return fail("App definitions must call cantelop.app({...}) at module scope");
  }
  const argument = expression.arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(argument) || argument.properties.some(p => ts.isSpreadAssignment(p))) return fail("App options must be a static object without spreads");
  const property = (name: string) => argument.properties.find(p => propertyName(p) === name);

  const nameProperty = property("name");
  if (!nameProperty || !ts.isPropertyAssignment(nameProperty) || !ts.isStringLiteral(nameProperty.initializer)) return fail("App name must be a string literal");
  const name = state.appName ?? nameProperty.initializer.text;
  if (!SLUG_PATTERN.test(name)) return fail("Invalid App name");
  if (state.names.has(name)) return fail(`Duplicate App name: ${name}`);
  state.names.add(name);

  const deployment: Record<string, unknown> = {};
  for (const key of ["environment", "dockerfile"]) {
    const option = property(key);
    if (option && ts.isPropertyAssignment(option)) deployment[key] = module.staticValue(option.initializer);
  }
  let configuration;
  try { configuration = validateAppDeploymentConfiguration(deployment); }
  catch (error) { return fail(error instanceof Error ? error.message : String(error)); }

  const runtimeProperty = property("runtime");
  if (!runtimeProperty || !ts.isPropertyAssignment(runtimeProperty)) return fail("Define runtime directly in the App options");
  const runtime = runtimeProperty.initializer;
  assertRuntimeContract(module, runtime);

  const webhookProperty = property("webhooks");
  const webhookExpression = webhookProperty && ts.isPropertyAssignment(webhookProperty) ? webhookProperty.initializer : undefined;
  if (webhookProperty && (!webhookExpression || !ts.isObjectLiteralExpression(webhookExpression))) fail("App webhooks must be an inline route object");
  const webhookRoutes = webhookExpression && ts.isObjectLiteralExpression(webhookExpression) ? staticWebhookRoutes(module, webhookExpression) : [];
  const homepageProperty = property("homepage");
  if (homepageProperty && !(ts.isMethodDeclaration(homepageProperty) || ts.isShorthandPropertyAssignment(homepageProperty) || ts.isPropertyAssignment(homepageProperty) &&
    (ts.isIdentifier(homepageProperty.initializer) || ts.isArrowFunction(homepageProperty.initializer) || ts.isFunctionExpression(homepageProperty.initializer)))) fail("App homepage must be an inline or imported handler");
  const webhookStatements = module.collect([...(webhookExpression ? [webhookExpression] : []), ...(homepageProperty ? [homepageProperty] : [])], true);
  for (const dependency of webhookStatements) state.allStatements.add(dependency);
  // Only Edge artifacts consume the webhook bundle; backend and Sandbox builds skip it.
  let webhookModule = "";
  if (state.webhooks) {
    const webhookSource = module.selectedSource(webhookStatements) + "\nexport default { webhooks: " + (webhookExpression ? module.print(webhookExpression) : "{}") + (homepageProperty ? ", " + module.print(homepageProperty) : "") + " };\n";
    const webhookBundle = await build({ stdin: { contents: webhookSource, resolveDir: path.dirname(filename), sourcefile: filename, loader: "ts" }, bundle: true, platform: "browser", format: "esm", target: "es2022", write: false, metafile: true, logLevel: "silent", plugins: [module.boundary] });
    webhookModule = webhookBundle.outputFiles![0]!.text;
    for (const input of Object.keys(webhookBundle.metafile?.inputs ?? {})) if (!input.startsWith("<")) watchFiles.add(path.resolve(input));
  }

  const authProperty = property("auth");
  if (authProperty && !(ts.isPropertyAssignment(authProperty) || ts.isShorthandPropertyAssignment(authProperty))) fail("App auth must be an inline or imported provider");
  const authExpression = authProperty && (ts.isShorthandPropertyAssignment(authProperty) ? authProperty.name : ts.isPropertyAssignment(authProperty) ? authProperty.initializer : undefined);
  // Auth runs only in the Sandbox, beside the runtime; its dependencies never reach backend or Edge builds.
  const runtimeStatements = module.collect([runtime, ...(authProperty ? [authProperty] : [])], true);
  for (const dependency of runtimeStatements) state.allStatements.add(dependency);
  const sandboxOnly = new Set<ts.Node>([runtimeProperty, ...(webhookProperty ? [webhookProperty] : []), ...(homepageProperty ? [homepageProperty] : []), ...(authProperty ? [authProperty] : [])]);
  for (const dependency of module.collect([expression.expression, ...argument.properties.filter(p => !sandboxOnly.has(p))], false)) {
    state.backendStatements.add(dependency); state.allStatements.add(dependency);
  }

  const runtimeSource = module.selectedSource(runtimeStatements) + "\nexport default " + module.print(runtime) + ";\n" + (authExpression ? "export const auth = " + module.print(authExpression) + ";\n" : "");
  // The runtime ID hashes this bundle, and esbuild keys CommonJS and lazy ESM modules by paths
  // relative to its working directory. Anchor them at the definition, not the build's cwd.
  const bundle = await build({ stdin: { contents: runtimeSource, resolveDir: path.dirname(filename), sourcefile: filename, loader: "ts" }, absWorkingDir: path.dirname(filename), bundle: true, platform: "node", format: "esm", target: "esnext", conditions: ["bun", "node", "import", "default"], external: ["bun:*"], write: false, metafile: true, minify: false, logLevel: "silent", plugins: [module.boundary] });
  const runtimeModule = bundle.outputFiles![0]!.text;
  for (const input of Object.keys(bundle.metafile?.inputs ?? {})) if (!input.startsWith("<")) watchFiles.add(path.resolve(path.dirname(filename), input));
  const contract = contractFingerprint(checker, checker.getTypeArguments(checker.getTypeAtLocation(expression) as ts.TypeReference), expression, module.program);
  const id = "rt_" + createHash("sha256").update(name).update((await transform(runtimeModule, { minify: true, legalComments: "none", target: "esnext" })).code).update(contract).update(JSON.stringify(configuration)).digest("hex");

  // The backend keeps the App call with Sandbox-only parts replaced by compiled markers.
  const dockerfileProperty = property("dockerfile");
  const edits = [
    { node: runtime, text: `{receive() { throw new Error("App runtime executes in the Sandbox"); }, [${symbolSource(RUNTIME_ID)}]: ${JSON.stringify(id)}}` },
    ...(state.appName === undefined ? [] : [{ node: nameProperty.initializer, text: JSON.stringify(name) }]),
    ...(dockerfileProperty && ts.isPropertyAssignment(dockerfileProperty) ? [{ node: dockerfileProperty.initializer, text: JSON.stringify(configuration.dockerfile) }] : []),
    ...(webhookExpression ? [{ node: webhookExpression, text: "{}" }] : []),
    ...(homepageProperty ? [{ node: homepageProperty, text: "homepage: undefined" }] : []),
    ...(authProperty ? [{ node: authProperty, text: `auth: {[${symbolSource(COMPILED_AUTH)}]: true}` }] : []),
  ];
  const statementStart = statement.getStart(file);
  let backendStatement = statement.getText(file);
  for (const edit of edits.sort((a, b) => b.node.getStart(file) - a.node.getStart(file))) {
    backendStatement = backendStatement.slice(0, edit.node.getStart(file) - statementStart) + edit.text + backendStatement.slice(edit.node.end - statementStart);
  }
  return {
    statement, backendStatement,
    app: { definition: { id, name, ...configuration, ...(authProperty ? { auth: true as const } : {}) }, entrypoint: filename, runtimeModule, webhookModule, webhookRoutes, hasHomepage: !!homepageProperty },
  };
}

/** Inline handler objects and typed factory calls must expose exactly one create or receive implementation with compatible parameters. */
function assertRuntimeContract(module: DefinitionModule, runtime: ts.Expression): void {
  const { checker } = module;
  // Factory calls remain Sandbox-only dependencies; the compiler never evaluates them.
  // Inspect their checked return type just as we inspect an inline handler object.
  const runtimeFactory = ts.isCallExpression(runtime);
  if (!runtimeFactory && (!ts.isObjectLiteralExpression(runtime) || runtime.properties.some(p => ts.isSpreadAssignment(p)))) module.fail("App runtime must be an inline handler object without spreads or a typed runtime factory call");
  const runtimeKeys = runtimeFactory
    ? checker.getPropertiesOfType(checker.getTypeAtLocation(runtime)).map(p => p.name)
    : (runtime as ts.ObjectLiteralExpression).properties.map(p => propertyName(p) ?? "");
  const harnessRuntime = runtimeKeys.includes("create");
  const allowedRuntimeKeys = harnessRuntime ? ["create", "onRecover", "redelivery"] : ["receive", "onActivate", "onRecover", "redelivery"];
  if (!runtimeKeys.includes(harnessRuntime ? "create" : "receive") || runtimeKeys.some(key => !allowedRuntimeKeys.includes(key))) module.fail("Invalid Session runtime: define exactly one create or receive implementation");
  const contextual = checker.getContextualType(runtime);
  if (contextual) for (const property of checker.getPropertiesOfType(contextual)) {
    const actual = checker.getPropertyOfType(checker.getTypeAtLocation(runtime), property.name);
    if (!actual) continue;
    const expectedSignature = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, runtime)).getCallSignatures()[0];
    const actualSignature = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(actual, runtime)).getCallSignatures()[0];
    if (expectedSignature && actualSignature) expectedSignature.parameters.forEach((parameter, index) => {
      const actualParameter = actualSignature.parameters[index];
      if (actualParameter && !checker.isTypeAssignableTo(checker.getTypeOfSymbolAtLocation(parameter, runtime), checker.getTypeOfSymbolAtLocation(actualParameter, runtime))) module.fail(`Invalid Session runtime ${property.name} parameter`);
    });
  }
}

/** Webhook routes are literal paths with inline `{ method, handle }` options so the Edge manifest is static. */
function staticWebhookRoutes(module: DefinitionModule, routes: ts.ObjectLiteralExpression): { path: string; method: "GET" | "POST" }[] {
  return routes.properties.map(route => {
    if (!ts.isPropertyAssignment(route) || !ts.isStringLiteral(route.name) || !ts.isObjectLiteralExpression(route.initializer)) return module.fail("Webhook routes must use literal paths and inline options");
    const fields = route.initializer.properties;
    if (fields.some(field => { const name = propertyName(field); return name !== "method" && name !== "handle"; })) return module.fail("Invalid App webhook route");
    const methodField = fields.find(field => propertyName(field) === "method");
    const handler = fields.find(field => propertyName(field) === "handle");
    if (!methodField || !ts.isPropertyAssignment(methodField) || !ts.isStringLiteral(methodField.initializer) || !handler) return module.fail("Webhook routes require a literal method and handler");
    const method = methodField.initializer.text;
    if (!isValidWebhookRoute(route.name.text, method)) return module.fail("Invalid App webhook route");
    return { path: route.name.text, method };
  });
}

/** Static definitions are split without importing or evaluating application code. */
export async function compileAppDefinitions(filename: string, compileOptions: { readonly webhooks?: boolean; readonly appName?: string } = {}) {
  filename = path.resolve(filename);
  const { options, configPath } = definitionCompilerOptions(filename);
  const program = ts.createProgram({ rootNames: [filename], options, host: cachingCompilerHost(options), ...(previousPrograms.has(filename) ? { oldProgram: previousPrograms.get(filename)! } : {}) });
  previousPrograms.set(filename, program);
  const file = program.getSourceFile(filename);
  const watchFiles = definitionWatchFiles(program, configPath);
  if (!file) throw new RuntimeContractError("Client definition does not exist", [...watchFiles]);
  const module = new DefinitionModule(filename, program, file, watchFiles);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) module.fail("Invalid Session runtime:\n" + ts.formatDiagnostics(diagnostics.slice(0, 10), { getCurrentDirectory: () => path.dirname(filename), getCanonicalFileName: f => f, getNewLine: () => "\n" }));
  const fileSymbol = module.checker.getSymbolAtLocation(file);
  if (!fileSymbol) return module.fail("Export at least one named App definition");

  const exports = module.checker.getExportsOfModule(fileSymbol);
  const { appExports, aliasDeclarations, candidates } = module.discoverApps(exports);
  if (!candidates.size) return module.fail("Export at least one App defined with cantelop.app({...})");
  if (compileOptions.appName !== undefined && (!SLUG_PATTERN.test(compileOptions.appName) || candidates.size !== 1))
    return module.fail("appName must be a valid App slug and requires exactly one App definition");
  module.appStatements = new Set([...candidates.keys()].map(node => module.topStatement(node)).filter((s): s is ts.Statement => !!s));

  const backendStatements = module.collect([...aliasDeclarations].map(d => d.initializer!), false);
  for (const alias of aliasDeclarations) { const statement = module.topStatement(alias); if (statement) backendStatements.add(statement); }
  const state: ExtractionState = {
    webhooks: compileOptions.webhooks !== false, names: new Set(), backendStatements,
    allStatements: new Set([...backendStatements, ...module.appStatements]),
    ...(compileOptions.appName === undefined ? {} : { appName: compileOptions.appName }),
  };
  const replacements = new Map<ts.Statement, string>();
  const apps = [];
  for (const candidate of candidates.values()) {
    const extracted = await extractApp(module, candidate, state);
    replacements.set(extracted.statement, extracted.backendStatement);
    apps.push(extracted.app);
  }
  module.assertModuleShape(exports, appExports, state.allStatements);
  const backendSource = file.statements.filter(s => backendStatements.has(s) || module.appStatements.has(s) || ts.isExportAssignment(s) || ts.isExportDeclaration(s))
    .map(s => replacements.get(s) ?? module.print(s)).join("\n");
  return { apps, backendSource, emitBackendDeclarations: () => emitBackendDeclarations(filename, options), watchFiles: [...watchFiles] };
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
  const host = cachingCompilerHost(declarationOptions);
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
