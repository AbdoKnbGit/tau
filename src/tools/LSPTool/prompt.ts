export const LSP_TOOL_NAME = 'LSP' as const

export const DESCRIPTION = `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

These are the ONLY valid values for "operation" — exactly these 9, nothing else:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: Search for symbols across the entire workspace
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

Do NOT pass any other value (e.g. "diagnostics", "rename", "completion", "formatting", "signatureHelp" are NOT operations and will fail). In particular, diagnostics (errors/warnings) are NOT something you request here: the language server publishes them automatically and they are delivered to you on their own after a file is opened or edited. There is no "diagnostics" operation — never call this tool to fetch them; just read the diagnostics that arrive by themselves.

For symbol operations (goToDefinition, findReferences, hover, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls) pass:
- filePath: the file to operate on
- symbol: the symbol name, e.g. "LogoV2". ALWAYS pass this — the tool locates the exact position for you. Do NOT compute or guess line/character: a hand-picked column almost always lands on a keyword (export/def/function) or whitespace rather than the symbol, which returns a wrong empty result. Only pass explicit 1-based line+character if you already have a precise editor cursor position.

documentSymbol lists every symbol in a file (filePath only). workspaceSymbol searches the whole project — pass the symbol name as the query.

Works for languages with a running language server (TS/JS, Python, HTML, CSS, JSON, etc.). If none supports the file's language, it says so and you should fall back to AFT or Grep.`
