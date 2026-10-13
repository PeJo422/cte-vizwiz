// Det enda UI:t vet om sin omgivning. Webbappen använder localStorage;
// en VS Code-webview kan senare tillhandahålla en annan implementation
// (dokumenttext via postMessage, revealRange tillbaka till editorn).
export interface Host {
  loadSql(): string | null;
  saveSql(sql: string): void;
}

const KEY = "cte-vizwiz:sql";

export const webHost: Host = {
  loadSql() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  saveSql(sql) {
    try {
      localStorage.setItem(KEY, sql);
    } catch {
      /* privat läge eller blockerad lagring – appen fungerar ändå */
    }
  },
};
