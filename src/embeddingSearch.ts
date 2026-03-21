import { EmbeddingEngine } from "./embeddingEngine";
import { EmbeddingIndex, NoteMatch, PassageMatch } from "./embeddingIndex";

export interface EmbeddingSearch {
  searchNotes(query: string, limit?: number): Promise<NoteMatch[]>;
  searchPassages(query: string, limit?: number): Promise<PassageMatch[]>;
  isReady(): boolean;
}

export function createEmbeddingSearch(
  engine: EmbeddingEngine,
  index: EmbeddingIndex
): EmbeddingSearch {
  return {
    async searchNotes(query: string, limit = 5): Promise<NoteMatch[]> {
      if (!engine.isReady()) return [];
      const queryVector = await engine.embed(query);
      return index.searchNotes(queryVector, limit);
    },

    async searchPassages(query: string, limit = 5): Promise<PassageMatch[]> {
      if (!engine.isReady()) return [];
      const queryVector = await engine.embed(query);
      return index.searchPassages(queryVector, limit, 0.5);
    },

    isReady(): boolean {
      return engine.isReady();
    },
  };
}
