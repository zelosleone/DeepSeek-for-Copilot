import { Language, Node, Parser } from 'web-tree-sitter';
import { logger } from './logger.js';

/**
 * AST-backed block trimming, replacing the indentation heuristic where a grammar is
 * available. Copilot's BlockTrimmer resolves the boundary from a tree-sitter
 * statement tree; this follows the same shape with one generic rule instead of a
 * per-language subclass, so it works for every grammar we ship.
 */

/** VS Code language id to the grammar file we vendor under `wasm/`. */
export const GRAMMAR_BY_LANGUAGE: Record<string, string> = {
  typescript: 'tree-sitter-typescript',
  typescriptreact: 'tree-sitter-tsx',
  javascript: 'tree-sitter-javascript',
  javascriptreact: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  csharp: 'tree-sitter-c-sharp',
  cpp: 'tree-sitter-cpp',
  c: 'tree-sitter-cpp',
  'cuda-cpp': 'tree-sitter-cpp',
  ruby: 'tree-sitter-ruby',
  php: 'tree-sitter-php',
  shellscript: 'tree-sitter-bash',
  powershell: 'tree-sitter-powershell',
  css: 'tree-sitter-css',
  ini: 'tree-sitter-ini',
  properties: 'tree-sitter-ini',
};

export function isTreeSitterSupported(languageId: string): boolean {
  return languageId in GRAMMAR_BY_LANGUAGE;
}

/**
 * Node types holding a sequence of statements. Names verified by dumping the
 * ancestor chain from each vendored grammar: C-family and PHP/bash use
 * `compound_statement`, Ruby `body_statement`, PowerShell `statement_list`,
 * Python `block`, INI `section`.
 */
const BLOCK_TYPES = new Set([
  'compound_statement',
  'statement_list',
  'translation_unit',
  'declaration_list',
  'field_declaration_list',
  'source_file',
  'program',
  'module',
  'document',
  'suite',
  'section',
]);

function isBlockLike(node: Node): boolean {
  const type = node.type;
  return BLOCK_TYPES.has(type) || type.includes('block') || type.includes('body');
}

/** A block-like child of `node` that spans the cursor. */
function blockChildSpanning(node: Node, cursorByte: number): Node | undefined {
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (child && isBlockLike(child) && child.startIndex <= cursorByte && child.endIndex >= cursorByte) {
      return child;
    }
  }
  return undefined;
}

/**
 * Nearest statement sequence containing the cursor. The cursor usually sits in
 * whitespace, so `descendantForIndex` returns the enclosing construct (`method`,
 * `function_statement`) rather than its body; walking only upwards would skip that
 * body entirely, which is why Ruby and PowerShell produced no boundary.
 */
function enclosingBlock(root: Node, cursorByte: number): Node | undefined {
  let node: Node | null = root.descendantForIndex(Math.max(0, cursorByte - 1), cursorByte);

  while (node) {
    const inner = blockChildSpanning(node, cursorByte);
    if (inner) return inner;
    if (isBlockLike(node)) return node;
    node = node.parent;
  }
  return undefined;
}

/**
 * The containing block's end offset, in bytes, or undefined when the tree offers no
 * useful boundary. Mirrors BlockTrimmer.getContainingBlockOffset: a compound
 * statement trims to itself, anything else to its nearest compound ancestor.
 */
export function containingBlockEnd(
  root: Node,
  cursorByte: number,
  completionEndByte: number,
): number | undefined {
  const block = enclosingBlock(root, cursorByte);
  if (!block) return undefined;

  // Pass 1, BlockTrimmer.getContainingBlockOffset: the completion closes the block
  // it started in, so cut where that block ends. This is the case where the model
  // finishes the current function and then starts writing the next one.
  if (block.endIndex > cursorByte && block.endIndex < completionEndByte) {
    return block.endIndex;
  }

  // Pass 2, BlockTrimmer.trimToStatement: the completion *opens* a new statement, so
  // the enclosing block spans everything and gives no boundary. The first sibling
  // beginning at or after the cursor is the statement being written; cut at its end.
  for (let i = 0; i < block.namedChildCount; i += 1) {
    const child = block.namedChild(i);
    if (child && child.startIndex >= cursorByte) return child.endIndex;
  }

  return undefined;
}

/**
 * Trims `completion` where it leaves the block containing the cursor. Returns
 * undefined when the tree gives no boundary, so the caller can fall back.
 */
export function trimWithTree(root: Node, prefixByteLength: number, completion: string): string | undefined {
  const completionBytes = new TextEncoder().encode(completion);
  const end = containingBlockEnd(root, prefixByteLength, prefixByteLength + completionBytes.length);
  if (end === undefined) return undefined;

  const offsetIntoCompletion = end - prefixByteLength;
  if (offsetIntoCompletion <= 0) return undefined;
  if (offsetIntoCompletion >= completionBytes.length) return undefined; // nothing to cut

  const trimmed = new TextDecoder().decode(completionBytes.slice(0, offsetIntoCompletion));
  // A trim that leaves nothing usable is worse than no trim.
  return trimmed.trim() ? trimmed : undefined;
}

type WasmReader = (fileName: string) => Promise<Uint8Array>;

let warnedAboutParserFailure = false;
let parserInit: Promise<void> | undefined;
let parser: Parser | undefined;
const languages = new Map<string, Language | undefined>();

async function loadLanguage(languageId: string, readWasm: WasmReader): Promise<Language | undefined> {
  if (languages.has(languageId)) return languages.get(languageId);

  let language: Language | undefined;
  try {
    const grammar = GRAMMAR_BY_LANGUAGE[languageId];
    if (grammar) language = await Language.load(await readWasm(`${grammar}.wasm`));
  } catch (error) {
    // Silent failure here previously looked identical to "nothing to trim".
    logger.warn(`[DeepSeek FIM] grammar for ${languageId} failed to load`, error);
  }
  languages.set(languageId, language);
  return language;
}

/**
 * Parses `prefix + completion` and trims at the block boundary. Returns undefined
 * whenever tree-sitter cannot help, which the caller treats as "use the heuristic".
 */
export async function trimToBlockWithTreeSitter(
  languageId: string,
  prefix: string,
  completion: string,
  readWasm: WasmReader,
): Promise<string | undefined> {
  if (!isTreeSitterSupported(languageId)) return undefined;

  try {
    // The core must be web-tree-sitter's own build; the grammar package ships a
    // core from a different tree-sitter release whose JS glue does not match.
    parserInit ??= Parser.init({
      wasmBinary: await readWasm('web-tree-sitter.wasm'),
    } as Parameters<typeof Parser.init>[0]);
    await parserInit;

    const language = await loadLanguage(languageId, readWasm);
    if (!language) return undefined;

    parser ??= new Parser();
    parser.setLanguage(language);

    const tree = parser.parse(prefix + completion);
    if (!tree?.rootNode) return undefined;

    const prefixBytes = new TextEncoder().encode(prefix).length;
    const result = trimWithTree(tree.rootNode, prefixBytes, completion);
    tree.delete();
    return result;
  } catch (error) {
    if (!warnedAboutParserFailure) {
      warnedAboutParserFailure = true;
      logger.warn('[DeepSeek FIM] tree-sitter unavailable, suggestions will not be block-trimmed', error);
    }
    return undefined;
  }
}
