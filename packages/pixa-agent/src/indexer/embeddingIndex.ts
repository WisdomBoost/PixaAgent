import type { RepoIndex } from "./types";
import { WorkspaceIndexer } from "./workspaceIndexer";
import type { VectorStore, QueryResult } from "./vectorStore";

/**
 * V2 index backend: combines WorkspaceIndexer's structural tree & file outlines
 * with a vector store for semantic code search.
 */
export class EmbeddingIndex implements RepoIndex {
  private workspaceIndexer: WorkspaceIndexer;

  constructor(
    workspaceRoot: string,
    private vectorStore: VectorStore
  ) {
    this.workspaceIndexer = new WorkspaceIndexer(workspaceRoot);
  }

  async getProjectMap(): Promise<string> {
    return this.workspaceIndexer.getProjectMap();
  }

  async getFileOutline(path: string): Promise<string> {
    return this.workspaceIndexer.getFileOutline(path);
  }

  refresh(): void {
    this.workspaceIndexer.refresh();
  }

  async query(text: string, topK?: number): Promise<QueryResult[]> {
    return this.vectorStore.query(text, topK);
  }

  async chunkCount(): Promise<number> {
    return this.vectorStore.size();
  }
}