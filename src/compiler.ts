import { fileURLToPath } from "node:url";
import { validateAppDeploymentConfiguration } from "./app-definition.js";
import ts from "typescript";
import path from "node:path";
import { createHash } from "node:crypto";
import { build, transform, type Plugin } from "esbuild";

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
export async function compileAppDefinitions(filename: string) {
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
  if (!fileSymbol) return fail("Export at least one named App definition");
  const resolveSymbol = (symbol: ts.Symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const canonicalPath = (filename: string) => ts.sys.realpath?.(filename) ?? path.resolve(filename);
  const isSDKType = (symbol: ts.Symbol | undefined, name: string, module: string) => symbol?.declarations?.some(d =>
    ts.isClassDeclaration(d) && d.name?.text === name && canonicalPath(d.getSourceFile().fileName) === canonicalPath(fileURLToPath(new URL(`./${module}.d.ts`, import.meta.url))));
  const topStatement = (node: ts.Node): ts.Statement | undefined => {
    while (node.parent && node.parent !== file) node = node.parent;
    return node.parent === file ? node as ts.Statement : undefined;
  };
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
        if (sandbox && symbol?.valueDeclaration?.getSourceFile() === file &&
          (isSDKType(typeSymbol, "App", "app") || isSDKType(typeSymbol, "CantelopClient", "client"))) fail("App runtime cannot capture an App or CantelopClient instance");
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
    if (!/^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) return fail("Invalid App name");
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
    if (!ts.isObjectLiteralExpression(runtime) || runtime.properties.some(p => ts.isSpreadAssignment(p))) return fail("App runtime must be an inline handler object without spreads");
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
    const runtimeStatements = collect([runtime], true);
    for (const dependency of runtimeStatements) allStatements.add(dependency);
    for (const dependency of collect([expression.expression, ...argument.properties.filter(p => p !== runtimeProperty)], false)) {
      backendStatements.add(dependency); allStatements.add(dependency);
    }
    const runtimeSource = selectedSource(runtimeStatements) + "\nexport default " + print(runtime) + ";\n";
    const bundle = await build({ stdin: { contents: runtimeSource, resolveDir: path.dirname(filename), sourcefile: filename, loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "esnext", conditions: ["bun", "node", "import", "default"], external: ["bun:*"], write: false, metafile: true, minify: false, logLevel: "silent" });
    const runtimeModule = bundle.outputFiles![0]!.text;
    for (const input of Object.keys(bundle.metafile?.inputs ?? {})) if (!input.startsWith("<")) watchFiles.push(path.resolve(input));
    const contract = contractFingerprint(checker, checker.getTypeArguments(checker.getTypeAtLocation(expression) as ts.TypeReference), expression, program);
    const id = "rt_" + createHash("sha256").update(name).update((await transform(runtimeModule, { minify: true, legalComments: "none", target: "esnext" })).code).update(contract).update(JSON.stringify(configuration)).digest("hex");
    const replacement = `{receive() { throw new Error("App runtime executes in the Sandbox"); }, [Symbol.for("dev.cantelop.sdk.compiled-runtime.v1")]: ${JSON.stringify(id)}}`;
    const statementText = statement.getText(file);
    const start = runtime.getStart(file) - statement.getStart(file);
    replacements.set(statement, statementText.slice(0, start) + replacement + statementText.slice(runtime.end - statement.getStart(file)));
    apps.push({ definition: { id, name, ...configuration }, entrypoint: filename, runtimeModule });
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
  return { apps, backendSource, watchFiles: [...new Set(watchFiles)] };
}

/** Select an App for an Edge/Sandbox artifact; multiple Apps require an explicit name. */
export async function compileClientDefinition(filename: string, app?: string) {
  const result = await compileAppDefinitions(filename);
  const selected = app === undefined && result.apps.length === 1 ? result.apps[0] : result.apps.find(value => value.definition.name === app);
  if (!selected) throw new RuntimeContractError(app === undefined ? "Multiple Apps: select an App by name" : `App not found: ${app}`, result.watchFiles);
  return { ...selected, backendSource: result.backendSource, watchFiles: result.watchFiles };
}

/** Use in the application's backend esbuild pipeline to exclude all Sandbox dependencies. */
export function createCantelopCompilerPlugin(options: { readonly definition: string }): Plugin {
  const definition = path.resolve(options.definition);
  return { name: "cantelop-app-compiler", setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, async args => {
      if (path.resolve(args.path) !== definition) return;
      try {
        const compiled = await compileAppDefinitions(definition);
        return { contents: compiled.backendSource, loader: "ts", resolveDir: path.dirname(definition), watchFiles: compiled.watchFiles };
      } catch (error) {
        return { errors: [{ text: error instanceof Error ? error.message : String(error) }], watchFiles: error instanceof RuntimeContractError ? [...error.watchFiles] : [definition] };
      }
    });
  } };
}
