const REPO = "Pugbread/Terminal-64";
const CURRENT_VERSION = "0.1.0";

export interface UpdateInfo {
  version: string;
  url: string;
  notes: string;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { Accept: "application/vnd.github.v3+json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const latest = (data.tag_name || "").replace(/^v/, "");
    if (latest && latest !== CURRENT_VERSION) {
      return {
        version: latest,
        url: data.html_url,
        notes: data.body || "",
      };
    }
  } catch {}
  return null;
}
