// Saves the work to a file locked with a password (AES-256-GCM, key from PBKDF2), so it can be opened
// again next month. The file never leaves the device unless the person moves it.
const MAGIC = new TextEncoder().encode("ICSAVE1");
const ITER = 250000;

async function keyOf(password: string, salt: Uint8Array<ArrayBuffer>) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function lock(data: unknown, password: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyOf(password, salt), new TextEncoder().encode(JSON.stringify(data))));
  const out = new Uint8Array(MAGIC.length + 28 + body.length);
  out.set(MAGIC); out.set(salt, MAGIC.length); out.set(iv, MAGIC.length + 16); out.set(body, MAGIC.length + 28);
  return out;
}

export async function unlock<T>(bytes: Uint8Array, password: string): Promise<T> {
  if (bytes.length < MAGIC.length + 29 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error("This isn't an Invoice Checker save file.");
  const at = MAGIC.length, salt = bytes.slice(at, at + 16), iv = bytes.slice(at + 16, at + 28);
  let plain: ArrayBuffer;
  try { plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await keyOf(password, salt), bytes.slice(at + 28)); } catch { throw new Error("Wrong password, or the file is damaged."); }
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
