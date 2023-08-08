import { arrayIntercalate } from "collection-utils";
import { ClassProperty, EnumType, ObjectType, Type } from "../Type";
import { matchType } from "../TypeUtils";
import { funPrefixNamer, Name, Namer, SimpleName } from "../Naming";
import { RenderContext } from "../Renderer";
import { BooleanOption, getOptionValues, Option, OptionValues } from "../RendererOptions";
import { acronymStyle, AcronymStyleOptions } from "../support/Acronyms";
import {
    allLowerWordStyle,
    capitalize,
    combineWords,
    firstUpperWordStyle,
    isLetterOrUnderscore,
    splitIntoWords,
    stringEscape,
    utf16StringEscape
} from "../support/Strings";
import { TargetLanguage } from "../TargetLanguage";
import { legalizeName } from "./JavaScript";
import { Sourcelike, SourcelikeArray } from "../Source";
import { panic } from "../support/Support";
import { ConvenienceRenderer } from "../ConvenienceRenderer";

export const typeScriptZodOptions = {
    justSchema: new BooleanOption("just-schema", "Schema only", false)
};

export class TypeScriptZodTargetLanguage extends TargetLanguage {
    protected getOptions(): Option<any>[] {
        return [];
    }

    constructor(
        displayName: string = "TypeScript Zod",
        names: string[] = ["typescript-zod"],
        extension: string = "ts"
    ) {
        super(displayName, names, extension);
    }

    protected makeRenderer(
        renderContext: RenderContext,
        untypedOptionValues: { [name: string]: any }
    ): TypeScriptZodRenderer {
        return new TypeScriptZodRenderer(
            this,
            renderContext,
            getOptionValues(typeScriptZodOptions, untypedOptionValues)
        );
    }
}

export class TypeScriptZodRenderer extends ConvenienceRenderer {
    constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof typeScriptZodOptions>
    ) {
        super(targetLanguage, renderContext);
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        return ["Class", "Date", "Object", "String", "Array", "JSON", "Error"];
    }

    protected nameStyle(original: string, upper: boolean): string {
        const acronyms = acronymStyle(AcronymStyleOptions.Camel);
        const words = splitIntoWords(original);
        return combineWords(
            words,
            legalizeName,
            upper ? firstUpperWordStyle : allLowerWordStyle,
            firstUpperWordStyle,
            upper ? s => capitalize(acronyms(s)) : allLowerWordStyle,
            acronyms,
            "",
            isLetterOrUnderscore
        );
    }

    protected makeNamedTypeNamer(): Namer {
        return funPrefixNamer("types", s => this.nameStyle(s, true));
    }

    protected makeUnionMemberNamer(): Namer {
        return funPrefixNamer("properties", s => this.nameStyle(s, true));
    }

    protected namerForObjectProperty(): Namer {
        return funPrefixNamer("properties", s => this.nameStyle(s, true));
    }

    protected makeEnumCaseNamer(): Namer {
        return funPrefixNamer("enum-cases", s => this.nameStyle(s, false));
    }

    private importStatement(lhs: Sourcelike, moduleName: Sourcelike): Sourcelike {
        return ["import ", lhs, " from ", moduleName, ";"];
    }

    protected emitImports(): void {
        this.ensureBlankLine();
        this.emitLine(this.importStatement("* as z", '"zod"'));
    }

    typeMapTypeForProperty(p: ClassProperty): Sourcelike {
        const typeMap = this.typeMapTypeFor(p.type);
        return p.isOptional ? [typeMap, ".optional()"] : typeMap;
    }

    typeMapTypeFor(t: Type, required: boolean = true): Sourcelike {
        if (["class", "object", "enum"].indexOf(t.kind) >= 0) {
            return [this.nameForNamedType(t), "Schema"];
        }

        const match = matchType<Sourcelike>(
            t,
            _anyType => "z.any()",
            _nullType => "z.null()",
            _boolType => "z.boolean()",
            _integerType => "z.number()",
            _doubleType => "z.number()",
            _stringType => "z.string()",
            arrayType => ["z.array(", this.typeMapTypeFor(arrayType.items, false), ")"],
            _classType => panic("Should already be handled."),
            _mapType => ["z.record(z.string(), ", this.typeMapTypeFor(_mapType.values, false), ")"],
            _enumType => panic("Should already be handled."),
            unionType => {
                const children = Array.from(unionType.getChildren()).map((type: Type) =>
                    this.typeMapTypeFor(type, false)
                );
                return ["z.union([", ...arrayIntercalate(", ", children), "])"];
            },
            _transformedStringType => {
                return "z.string()";
            }
        );

        if (required) {
            return [match];
        }

        return match;
    }

    private emitObject(name: Name, t: ObjectType) {
        this.ensureBlankLine();
        this.emitLine("\nexport const ", name, "Schema = ", "z.object({");
        this.indent(() => {
            this.forEachClassProperty(t, "none", (_, jsonName, property) => {
                this.emitLine(`"${utf16StringEscape(jsonName)}"`, ": ", this.typeMapTypeForProperty(property), ",");
            });
        });
        this.emitLine("});");
        if (!this._options.justSchema) {
            this.emitLine("export type ", name, " = z.infer<typeof ", name, "Schema>;");
        }
    }

    private emitEnum(e: EnumType, enumName: Name): void {
        this.ensureBlankLine();
        this.emitDescription(this.descriptionForType(e));
        this.emitLine("\nexport const ", enumName, "Schema = ", "z.enum([");
        this.indent(() =>
            this.forEachEnumCase(e, "none", (_, jsonName) => {
                this.emitLine('"', stringEscape(jsonName), '",');
            })
        );
        this.emitLine("]);");
        if (!this._options.justSchema) {
            this.emitLine("export type ", enumName, " = z.infer<typeof ", enumName, "Schema>;");
        }
    }

    private findName(arr: SourcelikeArray, source: Name): SimpleName | null {
        for (let i = 0; i < arr.length; i++) {
            const item = arr[i];

            if (item instanceof SimpleName && item !== source) {
                return item;
            } else if (Array.isArray(item)) {
                return this.findName(item, source);
            }
        }

        return null;
    }

    protected emitSchemas(): void {
        this.ensureBlankLine();

        this.forEachEnum("leading-and-interposing", (u: EnumType, enumName: Name) => {
            this.emitEnum(u, enumName);
        });

        const order: number[] = [];
        const queue: [number, SimpleName[]][] = [];
        const mapKey: Name[] = [];
        const mapValue: Sourcelike[][] = [];
        this.forEachObject("none", (type: ObjectType, name: Name) => {
            mapKey.push(name);
            mapValue.push(this.gatherSource(() => this.emitObject(name, type)));
        });

        mapKey.forEach((_, index) => {
            // pull out all names
            const source = mapValue[index];
            const names = source.filter(value => value as Name);
            const deps = [];

            // must be behind all these names
            for (let i = 1; i < names.length; i++) {
                const depName = names[i];

                if (Array.isArray(depName)) {
                    const dep = this.findName(depName, mapKey[index]);

                    if (dep) deps.push(dep);
                }
            }

            // insert index
            if (deps.length === 0) {
                order.push(index);
            } else {
                queue.push([index, deps]);
            }
        });

        while (queue.length > 0) {
            const name = queue.shift();
            if (!name) continue;

            const [index, deps] = name;
            let depsFound = 0;
            let ordinal = order.length - 1;

            for (let d = 0; d < deps.length; d++) {
                const dep = deps[d];

                for (let j = 0; j < order.length; j++) {
                    const depIndex = order[j];
                    const orderedSource = mapKey[depIndex];

                    if (orderedSource === dep) {
                        depsFound++;
                        // this is the index of the dependency, so make sure we come after it
                        ordinal = Math.max(ordinal, depIndex + 1);
                    }
                }
            }

            if (depsFound === deps.length) {
                order.splice(ordinal, 0, index);
            } else {
                queue.push(name);
            }
        }

        // now emit ordered source
        order.forEach(i => this.emitGatheredSource(mapValue[i]));
    }

    protected emitSourceStructure(): void {
        if (this.leadingComments !== undefined) {
            this.emitCommentLines(this.leadingComments);
        }

        this.emitImports();
        this.emitSchemas();
    }
}
