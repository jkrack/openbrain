import { writeFile, readFile } from "fs/promises";

export interface SectionVector {
  heading: string;
  text: string;
  vector: Float32Array;
}

export interface NoteVectors {
  path: string;
  mtime: number;
  noteVector: Float32Array;
  sections: SectionVector[];
}

export interface NoteMatch {
  path: string;
  basename: string;
  score: number;
}

export interface PassageMatch {
  path: string;
  heading: string;
  text: string;
  score: number;
}

export interface EmbeddingIndex {
  add(path: string, mtime: number, noteVector: Float32Array, sections: SectionVector[]): void;
  remove(path: string): void;
  has(path: string, mtime: number): boolean;
  searchNotes(queryVector: Float32Array, limit: number): NoteMatch[];
  searchPassages(queryVector: Float32Array, limit: number, minScore: number): PassageMatch[];
  save(filePath: string): Promise<void>;
  load(filePath: string): Promise<void>;
  clear(): void;
  allPaths(): string[];
  stats(): { noteCount: number; sectionCount: number; sizeBytes: number };
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  // Vectors are pre-normalized, so dot product = cosine similarity
  return dot;
}

const INDEX_VERSION = 1;

export function createEmbeddingIndex(dimensions: number): EmbeddingIndex {
  const entries = new Map<string, NoteVectors>();

  return {
    add(path, mtime, noteVector, sections) {
      entries.set(path, { path, mtime, noteVector, sections });
    },

    remove(path) {
      entries.delete(path);
    },

    has(path, mtime) {
      const entry = entries.get(path);
      return entry !== undefined && entry.mtime === mtime;
    },

    searchNotes(queryVector, limit) {
      const scored: NoteMatch[] = [];
      for (const entry of entries.values()) {
        const score = cosineSimilarity(queryVector, entry.noteVector);
        const basename = entry.path.split("/").pop()?.replace(/\.md$/, "") || entry.path;
        scored.push({ path: entry.path, basename, score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },

    searchPassages(queryVector, limit, minScore) {
      const scored: PassageMatch[] = [];
      for (const entry of entries.values()) {
        for (const section of entry.sections) {
          const score = cosineSimilarity(queryVector, section.vector);
          if (score > minScore) {
            scored.push({
              path: entry.path,
              heading: section.heading,
              text: section.text,
              score,
            });
          }
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },

    async save(filePath) {
      const entryList = Array.from(entries.values());
      // Calculate total size
      let size = 1 + 2 + 2 + 4; // version + modelIdLen placeholder + dims + count
      const modelIdBytes = new TextEncoder().encode("default");
      size += modelIdBytes.length;

      for (const entry of entryList) {
        const pathBytes = new TextEncoder().encode(entry.path);
        size += 2 + pathBytes.length; // path
        size += 8; // mtime
        size += dimensions * 4; // noteVector
        size += 2; // section count
        for (const s of entry.sections) {
          const hBytes = new TextEncoder().encode(s.heading);
          const tBytes = new TextEncoder().encode(s.text);
          size += 2 + hBytes.length; // heading
          size += 4 + tBytes.length; // text (uint32 for longer content)
          size += dimensions * 4; // vector
        }
      }

      const buffer = Buffer.alloc(size);
      let offset = 0;

      // Header
      buffer.writeUInt8(INDEX_VERSION, offset); offset += 1;
      buffer.writeUInt16LE(modelIdBytes.length, offset); offset += 2;
      modelIdBytes.forEach((b, i) => buffer.writeUInt8(b, offset + i));
      offset += modelIdBytes.length;
      buffer.writeUInt16LE(dimensions, offset); offset += 2;
      buffer.writeUInt32LE(entryList.length, offset); offset += 4;

      // Entries
      for (const entry of entryList) {
        const pathBytes = new TextEncoder().encode(entry.path);
        buffer.writeUInt16LE(pathBytes.length, offset); offset += 2;
        pathBytes.forEach((b, i) => buffer.writeUInt8(b, offset + i));
        offset += pathBytes.length;

        buffer.writeDoubleBE(entry.mtime, offset); offset += 8;

        for (let i = 0; i < dimensions; i++) {
          buffer.writeFloatLE(entry.noteVector[i], offset); offset += 4;
        }

        buffer.writeUInt16LE(entry.sections.length, offset); offset += 2;

        for (const s of entry.sections) {
          const hBytes = new TextEncoder().encode(s.heading);
          buffer.writeUInt16LE(hBytes.length, offset); offset += 2;
          hBytes.forEach((b, i) => buffer.writeUInt8(b, offset + i));
          offset += hBytes.length;

          const tBytes = new TextEncoder().encode(s.text);
          buffer.writeUInt32LE(tBytes.length, offset); offset += 4;
          tBytes.forEach((b, i) => buffer.writeUInt8(b, offset + i));
          offset += tBytes.length;

          for (let i = 0; i < dimensions; i++) {
            buffer.writeFloatLE(s.vector[i], offset); offset += 4;
          }
        }
      }

      await writeFile(filePath, buffer);
    },

    async load(filePath) {
      const data = await readFile(filePath);
      let offset = 0;
      const decoder = new TextDecoder();

      // Header
      const version = data.readUInt8(offset); offset += 1;
      if (version !== INDEX_VERSION) throw new Error(`Unsupported index version: ${version}`);

      const modelIdLen = data.readUInt16LE(offset); offset += 2;
      offset += modelIdLen; // skip model ID for now

      const dims = data.readUInt16LE(offset); offset += 2;
      const count = data.readUInt32LE(offset); offset += 4;

      entries.clear();

      for (let n = 0; n < count; n++) {
        const pathLen = data.readUInt16LE(offset); offset += 2;
        const path = decoder.decode(data.subarray(offset, offset + pathLen));
        offset += pathLen;

        const mtime = data.readDoubleBE(offset); offset += 8;

        const noteVector = new Float32Array(dims);
        for (let i = 0; i < dims; i++) {
          noteVector[i] = data.readFloatLE(offset); offset += 4;
        }

        const sectionCount = data.readUInt16LE(offset); offset += 2;
        const sections: SectionVector[] = [];

        for (let s = 0; s < sectionCount; s++) {
          const hLen = data.readUInt16LE(offset); offset += 2;
          const heading = decoder.decode(data.subarray(offset, offset + hLen));
          offset += hLen;

          const tLen = data.readUInt32LE(offset); offset += 4;
          const text = decoder.decode(data.subarray(offset, offset + tLen));
          offset += tLen;

          const vector = new Float32Array(dims);
          for (let i = 0; i < dims; i++) {
            vector[i] = data.readFloatLE(offset); offset += 4;
          }

          sections.push({ heading, text, vector });
        }

        entries.set(path, { path, mtime, noteVector, sections });
      }
    },

    allPaths() {
      return Array.from(entries.keys());
    },

    clear() {
      entries.clear();
    },

    stats() {
      let sectionCount = 0;
      let sizeBytes = 0;
      for (const entry of entries.values()) {
        sectionCount += entry.sections.length;
        sizeBytes += dimensions * 4; // noteVector
        for (const s of entry.sections) {
          sizeBytes += dimensions * 4 + s.text.length + s.heading.length;
        }
      }
      return { noteCount: entries.size, sectionCount, sizeBytes };
    },
  };
}
