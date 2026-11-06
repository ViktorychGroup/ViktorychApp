/* age-encryption 0.3.1 (Filippo Valsorda, BSD-3-Clause). The caller passes
   the loaded library. This file does not fetch, log, or store an identity. */

export async function encryptBytes(age, recipient, bytes) {
  const enc = new age.Encrypter();
  enc.addRecipient(recipient);
  const out = await enc.encrypt(bytes);
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

export async function decryptBytes(age, identity, bytes) {
  const dec = new age.Decrypter();
  dec.addIdentity(identity);
  const out = await dec.decrypt(bytes);
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}
