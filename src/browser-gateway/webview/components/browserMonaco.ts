// Monaco's language-worker helper loads all editor contributions lazily. Load
// their services before the first editor initialises the standalone collection,
// otherwise later contributions reference services that collection never saw.
import "monaco-editor/features/register.all";
import "monaco-editor/languages/definitions/cpp/register";
import "monaco-editor/languages/definitions/go/register";
import "monaco-editor/languages/definitions/java/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/rust/register";
import "monaco-editor/languages/definitions/shell/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/xml/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/features/css/register";
import "monaco-editor/languages/features/html/register";
import "monaco-editor/languages/features/json/register";
import "monaco-editor/languages/features/typescript/register";

export * from "monaco-editor/editor";
