import { useEffect, useRef } from "react";
import Editor, {
  DiffEditor as MonacoDiffEditor,
  loader,
  type OnMount,
} from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/i18n";

self.MonacoEnvironment = {
  getWorker: (_id, label) =>
    label === "typescript" || label === "javascript"
      ? new TypeScriptWorker()
      : new EditorWorker(),
};
loader.config({ monaco });
monaco.typescript.typescriptDefaults.setCompilerOptions({
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
  strict: true,
  noEmit: true,
  allowNonTsExtensions: true,
  lib: ["esnext", "dom"],
});
// Remote modules run in Deno, not this browser. Never fetch their source or types
// with the administrator's browser credentials just to provide editor hints.
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
  diagnosticCodesToIgnore: [2307],
});
monaco.typescript.typescriptDefaults.addExtraLib(
  `
declare namespace Deno {
  interface HttpServer { finished: Promise<void>; shutdown(): Promise<void>; }
  interface ServeOptions { port?: number; hostname?: string; signal?: AbortSignal; onListen?: (address: {hostname:string;port:number}) => void; }
  function serve(handler: (request: Request) => Response | Promise<Response>): HttpServer;
  function serve(options: ServeOptions, handler: (request: Request) => Response | Promise<Response>): HttpServer;
  namespace env { function get(key: string): string | undefined; function has(key: string): boolean; function toObject(): Record<string,string>; }
  function readTextFile(path: string | URL): Promise<string>;
  function readFile(path: string | URL): Promise<Uint8Array>;
}
`,
  "file:///shelter-deno.d.ts",
);

export interface CodeEditorHandle {
  format(): Promise<void>;
  validateSyntax(): Promise<number>;
  focusProblem(): void;
}
export interface FunctionCodeEditorProps {
  value: string;
  readOnly: boolean;
  label: string;
  onChange(value: string): void;
  onProblems(errors: number, warnings: number): void;
  onCursor(line: number, column: number): void;
  onDeploy(): void;
  onReady(handle: CodeEditorHandle | null): void;
}
export default function FunctionCodeEditor(props: FunctionCodeEditorProps) {
  const { t } = useI18n();
  const callbacks = useRef(props);
  callbacks.current = props;
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  useEffect(() => () => callbacks.current.onReady(null), []);
  const mount: OnMount = (instance) => {
    editor.current = instance;
    const theme = () => {
      const dark = document.documentElement.classList.contains("dark");
      const style = getComputedStyle(document.documentElement);
      const token = (name: string, fallback: string) =>
        style.getPropertyValue(name).trim() || fallback;
      monaco.editor.defineTheme("shelter-function", {
        base: dark ? "vs-dark" : "vs",
        inherit: true,
        rules: [],
        colors: {
          "editor.background": token("--card", dark ? "#151515" : "#ffffff"),
          "editor.foreground": token(
            "--foreground",
            dark ? "#ededed" : "#202020",
          ),
          "editorLineNumber.foreground": token("--muted-foreground", "#737373"),
          "editorLineNumber.activeForeground": token("--foreground", "#202020"),
          "editorCursor.foreground": token("--primary", "#202020"),
          "editor.selectionBackground": token("--accent", "#ededed"),
          "editorWidget.background": token("--card", "#ffffff"),
          "editorWidget.border": token("--border", "#e7e7e7"),
        },
      });
      monaco.editor.setTheme("shelter-function");
    };
    theme();
    const observer = new MutationObserver(theme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-resolved-theme"],
    });
    const cursor = instance.onDidChangeCursorPosition((event) =>
      callbacks.current.onCursor(
        event.position.lineNumber,
        event.position.column,
      ),
    );
    instance.onDidDispose(() => {
      observer.disconnect();
      cursor.dispose();
    });
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
      callbacks.current.onDeploy(),
    );
    callbacks.current.onReady({
      format: async () => {
        await instance.getAction("editor.action.formatDocument")?.run();
      },
      validateSyntax: async () => {
        const model = instance.getModel();
        if (!model) throw new Error("Editor is not ready");
        const worker = await (
          await monaco.typescript.getTypeScriptWorker()
        )(model.uri);
        return (await worker.getSyntacticDiagnostics(model.uri.toString()))
          .length;
      },
      focusProblem: () => {
        instance.focus();
        void instance.getAction("editor.action.marker.next")?.run();
      },
    });
  };
  return (
    <Editor
      height="100%"
      language="typescript"
      value={props.value}
      onMount={mount}
      loading={
        <div
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Spinner />
          {t("Loading editor…", "Editor wird geladen…")}
        </div>
      }
      onChange={(value) => callbacks.current.onChange(value ?? "")}
      onValidate={(markers) =>
        callbacks.current.onProblems(
          markers.filter((m) => m.severity === monaco.MarkerSeverity.Error)
            .length,
          markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning)
            .length,
        )
      }
      options={{
        ariaLabel: props.label,
        readOnly: props.readOnly,
        automaticLayout: true,
        fontFamily: '"Geist Mono Variable", monospace',
        fontSize: 13,
        lineHeight: 22,
        minimap: { enabled: false },
        padding: { top: 18, bottom: 18 },
        scrollBeyondLastLine: false,
        tabSize: 2,
        insertSpaces: true,
        formatOnPaste: true,
        formatOnType: true,
        wordWrap: "on",
        folding: true,
        glyphMargin: false,
        lineNumbersMinChars: 3,
        bracketPairColorization: { enabled: true },
        renderLineHighlight: "gutter",
        fixedOverflowWidgets: true,
      }}
    />
  );
}

export function FunctionDiff({
  original,
  modified,
}: {
  original: string;
  modified: string;
}) {
  return (
    <MonacoDiffEditor
      height="100%"
      language="typescript"
      original={original}
      modified={modified}
      theme="shelter-function"
      options={{
        readOnly: true,
        automaticLayout: true,
        renderSideBySide: false,
        minimap: { enabled: false },
        fontFamily: '"Geist Mono Variable", monospace',
        fontSize: 13,
        scrollBeyondLastLine: false,
      }}
    />
  );
}
