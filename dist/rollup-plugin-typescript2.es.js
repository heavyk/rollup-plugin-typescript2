/* eslint-disable */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import * as fs from 'fs';
import { ModuleKind, ScriptSnapshot, createDocumentRegistry, createLanguageService, flattenDiagnosticMessageText, getDefaultLibFilePath, nodeModuleNameResolver, parseConfigFileTextToJson, parseJsonConfigFileContent, sys } from 'typescript';
import * as ts from 'typescript';
import { each, endsWith, find, has, map, some } from 'lodash';
import * as _ from 'lodash';
import { Graph, alg } from 'graphlib';
import * as graph from 'graphlib';
import { sha1 } from 'object-hash';
import * as hash from 'object-hash';
import { sync } from 'mkdirp';
import * as mkdirp from 'mkdirp';
import { createFilter } from 'rollup-pluginutils';
import { dirname, sep } from 'path';
import * as path from 'path';

const __assign = Object.assign || function (target) {
    for (var source, i = 1; i < arguments.length; i++) {
        source = arguments[i];
        for (var prop in source) {
            if (Object.prototype.hasOwnProperty.call(source, prop)) {
                target[prop] = source[prop];
            }
        }
    }
    return target;
};

var LanguageServiceHost = (function () {
    function LanguageServiceHost(parsedConfig) {
        this.parsedConfig = parsedConfig;
        this.cwd = process.cwd();
        this.snapshots = {};
    }
    LanguageServiceHost.prototype.setSnapshot = function (fileName, data) {
        var snapshot = ScriptSnapshot.fromString(data);
        this.snapshots[fileName] = snapshot;
        return snapshot;
    };
    LanguageServiceHost.prototype.getScriptSnapshot = function (fileName) {
        if (has(this.snapshots, fileName))
            return this.snapshots[fileName];
        if (existsSync(fileName)) {
            this.snapshots[fileName] = ScriptSnapshot.fromString(sys.readFile(fileName));
            return this.snapshots[fileName];
        }
        return undefined;
    };
    LanguageServiceHost.prototype.getCurrentDirectory = function () {
        return this.cwd;
    };
    LanguageServiceHost.prototype.getScriptVersion = function (_fileName) {
        return "0";
    };
    LanguageServiceHost.prototype.getScriptFileNames = function () {
        return this.parsedConfig.fileNames;
    };
    LanguageServiceHost.prototype.getCompilationSettings = function () {
        return this.parsedConfig.options;
    };
    LanguageServiceHost.prototype.getDefaultLibFileName = function (opts) {
        return getDefaultLibFilePath(opts);
    };
    return LanguageServiceHost;
}());

var Cache = (function () {
    function Cache(cacheRoot, options, rootFilenames) {
        this.cacheRoot = cacheRoot;
        this.options = options;
        this.cacheVersion = "0";
        this.treeComplete = false;
        this.cacheRoot = this.cacheRoot + "/" + sha1({ version: this.cacheVersion, rootFilenames: rootFilenames, options: this.options });
        sync(this.cacheRoot);
        this.dependencyTree = new Graph({ directed: true });
        this.dependencyTree.setDefaultNodeLabel(function (_node) { return { dirty: false }; });
    }
    Cache.prototype.walkTree = function (cb) {
        var acyclic = alg.isAcyclic(this.dependencyTree);
        if (acyclic) {
            each(alg.topsort(this.dependencyTree), function (id) { return cb(id); });
            return;
        }
        // console.log("cycles detected in dependency graph, not sorting");
        each(this.dependencyTree.nodes(), function (id) { return cb(id); });
    };
    Cache.prototype.setDependency = function (importee, importer) {
        // console.log(importer, "->", importee);
        // importee -> importer
        this.dependencyTree.setEdge(importer, importee);
    };
    Cache.prototype.lastDependencySet = function () {
        this.treeComplete = true;
    };
    Cache.prototype.markAsDirty = function (id, _snapshot) {
        this.dependencyTree.setNode(id, { dirty: true });
    };
    // returns true if node or any of its imports changed
    Cache.prototype.isDirty = function (id, _snapshot, checkImports) {
        var _this = this;
        var label = this.dependencyTree.node(id);
        if (!label)
            return false;
        if (!checkImports || label.dirty)
            return label.dirty;
        var dependencies = alg.dijkstra(this.dependencyTree, id);
        return some(dependencies, function (dependency, node) {
            if (!node || dependency.distance === Infinity)
                return false;
            var l = _this.dependencyTree.node(node);
            var dirty = l === undefined ? true : l.dirty;
            if (dirty)
                console.log("dirty: " + id + " -> " + node);
            return dirty;
        });
    };
    Cache.prototype.getCompiled = function (id, snapshot, transform) {
        var path$$1 = this.makePath(id, snapshot);
        if (!existsSync(path$$1) || this.isDirty(id, snapshot, false)) {
            // console.log(`compile cache miss: ${id}`);
            var data = transform();
            this.setCache(path$$1, id, snapshot, data);
            return data;
        }
        return JSON.parse(readFileSync(path$$1, "utf8"));
    };
    Cache.prototype.getDiagnostics = function (id, snapshot, check) {
        var path$$1 = this.makePath(id, snapshot) + ".diagnostics";
        if (!existsSync(path$$1) || this.isDirty(id, snapshot, true)) {
            // console.log(`diagnostics cache miss: ${id}`);
            var data = this.convert(check());
            this.setCache(path$$1, id, snapshot, data);
            return data;
        }
        return JSON.parse(readFileSync(path$$1, "utf8"));
    };
    Cache.prototype.setCache = function (path$$1, id, snapshot, data) {
        if (data === undefined)
            return;
        writeFileSync(path$$1, JSON.stringify(data));
        this.markAsDirty(id, snapshot);
    };
    Cache.prototype.makePath = function (id, snapshot) {
        var data = snapshot.getText(0, snapshot.getLength());
        return this.cacheRoot + "/" + sha1({ data: data, id: id });
    };
    Cache.prototype.convert = function (data) {
        return map(data, function (diagnostic) {
            var entry = {
                flatMessage: flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
            };
            if (diagnostic.file) {
                var _a = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start), line = _a.line, character = _a.character;
                entry.fileLine = diagnostic.file.fileName + " (" + (line + 1) + "," + (character + 1) + ")";
            }
            return entry;
        });
    };
    return Cache;
}());

function getOptionsOverrides() {
    return {
        module: ModuleKind.ES2015,
        sourceMap: true,
        noEmitHelpers: true,
        importHelpers: true,
        noResolve: false,
    };
}
// Gratefully lifted from 'look-up', due to problems using it directly:
//   https://github.com/jonschlinkert/look-up/blob/master/index.js
//   MIT Licenced
function findFile(cwd, filename) {
    var fp = cwd ? (cwd + "/" + filename) : filename;
    if (existsSync(fp)) {
        return fp;
    }
    var segs = cwd.split(sep);
    var len = segs.length;
    while (len--) {
        cwd = segs.slice(0, len).join("/");
        fp = cwd + "/" + filename;
        if (existsSync(fp)) {
            return fp;
        }
    }
    return null;
}
// The injected id for helpers.
var TSLIB = "tslib";
var tslibSource;
try {
    // tslint:disable-next-line:no-string-literal no-var-requires
    var tslibPath = require.resolve("tslib/" + require("tslib/package.json")["module"]);
    tslibSource = readFileSync(tslibPath, "utf8");
}
catch (e) {
    console.warn("Error loading `tslib` helper library.");
    throw e;
}
function parseTsConfig() {
    var fileName = findFile(process.cwd(), "tsconfig.json");
    if (!fileName)
        throw new Error("couldn't find 'tsconfig.json' in " + process.cwd());
    var text = sys.readFile(fileName);
    var result = parseConfigFileTextToJson(fileName, text);
    var configParseResult = parseJsonConfigFileContent(result.config, sys, dirname(fileName), getOptionsOverrides(), fileName);
    return configParseResult;
}
function printDiagnostics(diagnostics) {
    each(diagnostics, function (diagnostic) {
        if (diagnostic.fileLine)
            console.log(diagnostic.fileLine + ": " + diagnostic.flatMessage);
        else
            console.log(diagnostic.flatMessage);
    });
}

function typescript(options) {
    options = __assign({}, options);
    var filter = createFilter(options.include || ["*.ts+(|x)", "**/*.ts+(|x)"], options.exclude || ["*.d.ts", "**/*.d.ts"]);
    var parsedConfig = parseTsConfig();
    var servicesHost = new LanguageServiceHost(parsedConfig);
    var services = createLanguageService(servicesHost, createDocumentRegistry());
    var cache = new Cache(process.cwd() + "/.rts2_cache", parsedConfig.options, parsedConfig.fileNames);
    return {
        resolveId: function (importee, importer) {
            if (importee === TSLIB)
                return "\0" + TSLIB;
            if (!importer)
                return null;
            importer = importer.split("\\").join("/");
            var result = nodeModuleNameResolver(importee, importer, parsedConfig.options, sys);
            if (result.resolvedModule && result.resolvedModule.resolvedFileName) {
                if (endsWith(result.resolvedModule.resolvedFileName, ".d.ts"))
                    return null;
                if (filter(result.resolvedModule.resolvedFileName))
                    cache.setDependency(result.resolvedModule.resolvedFileName, importer);
                return result.resolvedModule.resolvedFileName;
            }
            return null;
        },
        load: function (id) {
            if (id === "\0" + TSLIB)
                return tslibSource;
            return undefined;
        },
        transform: function (code, id) {
            var _this = this;
            if (!filter(id))
                return undefined;
            var snapshot = servicesHost.setSnapshot(id, code);
            var result = cache.getCompiled(id, snapshot, function () {
                var output = services.getEmitOutput(id);
                if (output.emitSkipped)
                    _this.error({ message: "failed to transpile " + id });
                var transpiled = find(output.outputFiles, function (entry) { return endsWith(entry.name, ".js"); });
                var map$$1 = find(output.outputFiles, function (entry) { return endsWith(entry.name, ".map"); });
                return {
                    code: transpiled ? transpiled.text : undefined,
                    map: map$$1 ? JSON.parse(map$$1.text) : { mappings: "" },
                };
            });
            return result;
        },
        outro: function () {
            cache.lastDependencySet();
            cache.walkTree(function (id) {
                var snapshot = servicesHost.getScriptSnapshot(id);
                if (!snapshot) {
                    console.log("failed lo load snapshot for " + id);
                    return;
                }
                var diagnostics = cache.getDiagnostics(id, snapshot, function () {
                    return services
                        .getCompilerOptionsDiagnostics()
                        .concat(services.getSyntacticDiagnostics(id))
                        .concat(services.getSemanticDiagnostics(id));
                });
                printDiagnostics(diagnostics);
            });
        },
    };
}

export default typescript;
