import { useState } from "react";
import { VaultIndex } from "../vaultIndex";

interface GraphDashboardProps {
  vaultIndex: VaultIndex | null;
}

export function GraphDashboard({ vaultIndex }: GraphDashboardProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<string[]>([]);

  if (!vaultIndex) {
    return <div className="ob-detached-placeholder">Vault index not available</div>;
  }

  const allEntries = vaultIndex.getAllEntries();
  const typeCounts = new Map<string, number>();
  let totalMentions = 0;

  for (const entry of allEntries) {
    if (entry.frontmatterType) {
      typeCounts.set(entry.frontmatterType, (typeCounts.get(entry.frontmatterType) || 0) + 1);
    }
    totalMentions += entry.mentionsPeople.length + entry.mentionsProjects.length + entry.mentionsTopics.length;
  }

  // Most connected
  const connectionScores = allEntries
    .map((e) => ({
      path: e.path,
      basename: e.basename,
      connections: vaultIndex.getBacklinks(e.path).length +
        e.links.length +
        e.mentionsPeople.length + e.mentionsProjects.length + e.mentionsTopics.length +
        vaultIndex.getMentionedBy(e.path).length,
    }))
    .filter((n) => n.connections > 0)
    .sort((a, b) => b.connections - a.connections)
    .slice(0, 10);

  const handleSearch = () => {
    if (!searchQuery.trim()) { setSearchResults([]); return; }
    const entityPath = searchQuery.endsWith(".md") ? searchQuery : searchQuery + ".md";
    const mentioners = vaultIndex.getMentionedBy(entityPath);
    // Also search by basename
    const basename = searchQuery.toLowerCase();
    const byLink: string[] = [];
    for (const entry of allEntries) {
      for (const link of entry.links) {
        if (link.toLowerCase().includes(basename)) {
          if (!byLink.includes(entry.path) && !mentioners.includes(entry.path)) {
            byLink.push(entry.path);
          }
        }
      }
    }
    setSearchResults([...mentioners, ...byLink]);
  };

  return (
    <div className="ob-detached-graph-dashboard">
      <div className="ob-detached-graph-stats">
        <div className="ob-detached-graph-stat">
          <div className="ob-detached-graph-stat-value">{allEntries.length}</div>
          <div className="ob-detached-graph-stat-label">Notes</div>
        </div>
        <div className="ob-detached-graph-stat">
          <div className="ob-detached-graph-stat-value">{totalMentions}</div>
          <div className="ob-detached-graph-stat-label">Relationships</div>
        </div>
        {Array.from(typeCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([type, count]) => (
            <div key={type} className="ob-detached-graph-stat">
              <div className="ob-detached-graph-stat-value">{count}</div>
              <div className="ob-detached-graph-stat-label">{type}</div>
            </div>
          ))}
      </div>

      <div className="ob-detached-graph-section">
        <h3>Most Connected</h3>
        {connectionScores.map((node) => (
          <div key={node.path} className="ob-detached-graph-node">
            <span>{node.basename}</span>
            <span className="ob-detached-context-meta">{node.connections} connections</span>
          </div>
        ))}
      </div>

      <div className="ob-detached-graph-section">
        <h3>Entity Search</h3>
        <div className="ob-detached-graph-search">
          <input
            type="text"
            placeholder="Search for a person, project, or topic..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
            className="ob-detached-graph-search-input"
          />
          <button onClick={handleSearch} className="ob-detached-skill-run">Search</button>
        </div>
        {searchResults.length > 0 && (
          <div className="ob-detached-graph-results">
            {searchResults.map((path) => (
              <div key={path} className="ob-detached-graph-node">{path}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
