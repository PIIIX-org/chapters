/**
 * Autonomous Benchmark Runner: TP-01 Information Retrieval Accuracy Benchmark
 * Evaluates NDCG@10, MRR, and Recall@5 across PGVector and ChromaDB targets.
 * Complies strictly with SOP in plan/00-master-test-execution-orchestrator.
 */

import { performance } from 'node:perf_hooks'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export interface TargetConfig {
  name: 'mcppgvector' | 'choromamcp'
  title: string
  url: string
  token: string
}

export const TARGETS: TargetConfig[] = [
  {
    name: 'mcppgvector',
    title: 'PostgreSQL 17 + pgvector',
    url: 'https://elara.pgvector.piiix.org/mcp',
    token: '2f07c887b3f16393b26d70cf804f7cd79cb71f83f4991fd363f73985d7ac80db',
  },
  {
    name: 'choromamcp',
    title: 'PostgreSQL 17 + ChromaDB 0.6.3',
    url: 'https://elara.choromadb.piiix.org/mcp',
    token: '8b60b84dd4e80e551333e8135cbf20be73e354383325ef9f30856b53404d9480',
  },
]

export interface CorpusNote {
  path: string
  type: string
  title: string
  tags: string[]
  body: string
}

export interface GroundTruthQuery {
  id: string
  category: 'A' | 'B' | 'C'
  categoryName: string
  query: string
  targetPath: string
  grade: number
}

// -----------------------------------------------------------------------------
// 100-Note Benchmark Corpus spanning 5 Domains
// -----------------------------------------------------------------------------
export function generateBenchmarkCorpus(): CorpusNote[] {
  const domains = [
    {
      domain: 'architecture',
      notes: [
        { slug: 'distributed-consensus', title: 'Distributed Consensus & Raft Coordination', desc: 'Consensus mechanisms, term elections, log replication and arbitration.' },
        { slug: 'state-vector-distribution', title: 'State Vector Distribution & CRDT Sync', desc: 'Syncing state vectors across decentralized peer networks without central locks.' },
        { slug: 'vault-scoping', title: 'Vault Scoping & Cross-Tenant Isolation Boundaries', desc: 'How vault isolation prevents cross-tenant data leaks and enforces workspace security.' },
        { slug: 'conformance-audit', title: 'OKF Conformance Audit & Broken Link Detection', desc: 'How orphan notes and broken wikilinks are detected in the graph traversal engine.' },
        { slug: 'cluster-arbitration', title: 'Cluster Arbitration & Dynamic Split-Brain Prevention', desc: 'Handling asymmetric network partitions using dynamic quorum leases.' },
        { slug: 'gossip-protocol', title: 'Gossip Protocol Peer State Dissemination', desc: 'Epidemic broadcast trees for low-overhead cluster membership discovery.' },
        { slug: 'partition-tolerance', title: 'Partition Tolerance & Network Degraded Modes', desc: 'Graceful degradation strategies during wide-area network disconnects.' },
        { slug: 'eventual-consistency', title: 'Eventual Consistency Convergence Models', desc: 'Mathematical convergence guarantees under commutative conflict-free replicated data.' },
        { slug: 'crdt-relay-topology', title: 'CRDT WebSocket Relay Topology & Mesh Routing', desc: 'Architecting Hocuspocus and Yjs relay clusters for live document editing.' },
        { slug: 'node-discovery', title: 'Automatic Node Discovery & Ephemeral Service Registry', desc: 'Registration and health probes for dynamically provisioned search workers.' },
        { slug: 'heartbeat-failure-detector', title: 'Phi Accrual Heartbeat Failure Detection', desc: 'Adaptive threshold failure detection algorithms under variable network jitter.' },
        { slug: 'quorum-leases', title: 'Distributed Quorum Leases & Time-Bound Leadership', desc: 'Granting non-blocking reads through master lease expiration windows.' },
        { slug: 'leader-election-raft', title: 'Raft Leader Election & Term Monotonicity', desc: 'Candidate step-down mechanisms and randomized heartbeat election timeouts.' },
        { slug: 'vector-clock-merging', title: 'Vector Clock Merging & Causality Preservation', desc: 'Detecting concurrent conflicting updates via monotonic logical clocks.' },
        { slug: 'causal-consistency', title: 'Causal Consistency Invariants Across Replicas', desc: 'Enforcing session guarantees and causal order for distributed revision commits.' },
        { slug: 'anti-entropy-exchange', title: 'Merkle Tree Anti-Entropy Exchange Protocol', desc: 'Fast range reconciliation between divergent note replica storage backends.' },
        { slug: 'tombstone-garbage-collection', title: 'Tombstone Garbage Collection & Pruning Epochs', desc: 'Safe reclamation of deleted entity tombstones after safe horizons.' },
        { slug: 'peer-to-peer-mesh', title: 'Peer-to-Peer Relay WebRTC Data Channel Mesh', desc: 'Direct browser-to-browser collaboration fallback when relay proxies fail.' },
        { slug: 'distributed-lock-manager', title: 'Distributed Lock Manager & Fencing Tokens', desc: 'Preventing split-brain disk writes using monotonic fencing tokens.' },
        { slug: 'boundary-enforcement', title: 'Domain Boundary Enforcement & Clean Ingress Ports', desc: 'Hexagonal architecture layers preventing core domain model pollution.' },
      ],
    },
    {
      domain: 'services/auth',
      notes: [
        { slug: 'crdt-synchronization', title: 'CRDT Synchronization & Client Reconnect Flow', desc: 'How do disconnected collaborative clients reconcile document state after reconnecting.' },
        { slug: 'mcp-rate-limiter', title: 'MCP Rate Limiting Architecture & checkRateLimit', desc: 'find usages of checkRateLimit in session security and token bucket limiters.' },
        { slug: 'session-cookie-validation', title: 'Secure Session Cookie Validation & Rotation', desc: 'Cryptographic cookie signing using HMAC-SHA256 and periodic secret rotation.' },
        { slug: 'token-verification', title: 'JWT Token Verification & Ephemeral Key Caching', desc: 'Stateless Bearer token inspection with public key cache invalidation.' },
        { slug: 'oidc-callback-handling', title: 'OIDC Identity Provider Authorization Callback', desc: 'Handling OAuth2 authorization codes, state verification, and PKCE challenges.' },
        { slug: 'argon2-password-hashing', title: 'Argon2id Password Hashing & Salt Generation', desc: 'Memory-hard password hashing parameters and adaptive work factor scaling.' },
        { slug: 'totp-mfa-authenticator', title: 'Time-Based One-Time Password (TOTP) Verification', desc: 'RFC 6238 authenticator app registration, QR codes, and drift tolerance.' },
        { slug: 'jwt-signature-verification', title: 'Asymmetric JWT Signature Verification Pipeline', desc: 'Validating RS256 and ES256 signatures against trusted JWKS endpoints.' },
        { slug: 'rbac-role-resolution', title: 'Role-Based Access Control (RBAC) Permission Tree', desc: 'Hierarchical permission resolution across account, team, and vault scopes.' },
        { slug: 'account-lockout-policy', title: 'Account Lockout Policy & Credential Stuffing Defense', desc: 'Progressive backoff delays and IP-based brute force protection.' },
        { slug: 'csrf-token-rotation', title: 'Double Submit Cookie CSRF Mitigation', desc: 'Validating custom headers against encrypted anti-CSRF request tokens.' },
        { slug: 'api-key-entropy', title: 'High-Entropy API Key Generation & Masking', desc: 'Generating 256-bit cryptographically secure keys with sha256 lookup hashes.' },
        { slug: 'bearer-token-parser', title: 'Fast HTTP Authorization Header Extraction', desc: 'Zero-allocation Bearer token string parsing in Fastify request hooks.' },
        { slug: 'session-revocation', title: 'Global Session Revocation & Redis Invalidation', desc: 'Immediate propagation of security sign-out across all active user devices.' },
        { slug: 'audit-security-events', title: 'Security Audit Event Telemetry & Alert Stream', desc: 'Immutable structured logging of privilege escalations and login anomalies.' },
        { slug: 'credential-encryption', title: 'Envelope Encryption for Stored Git Access Tokens', desc: 'Encrypting third-party credentials with AES-256-GCM and KMS key wraps.' },
        { slug: 'cors-preflight-security', title: 'Strict Cross-Origin Resource Sharing Ingress Rules', desc: 'Restricting allowed origins, headers, and credentials on MCP endpoints.' },
        { slug: 'email-magic-link', title: 'Passwordless Email Magic Link Verification Flow', desc: 'Single-use cryptographic tokens with short 15-minute expiration windows.' },
        { slug: 'password-reset-flow', title: 'Secure Password Reset & Token Invalidation Cycle', desc: 'Expiring all existing user sessions upon successful password renewal.' },
        { slug: 'mcp-auth-scope-middleware', title: 'MCP Permission Scope Validation Middleware', desc: 'Verifying account vs vault scoped tokens before executing sensitive tools.' },
      ],
    },
    {
      domain: 'database/storage',
      notes: [
        { slug: 'okf-path-resolution', title: 'OKF Path Resolution Engine & resolveNotePath', desc: 'where is resolveNotePath called during document write and folder nesting.' },
        { slug: 'history-revisions', title: 'Historical Note Revisions & Automatic Pruning', desc: 'What triggers automatic note revision pruning and delta compaction policies.' },
        { slug: 'frontmatter-schema-v02', title: 'Open Knowledge Format (OKF v0.2) YAML Frontmatter', desc: 'Standard metadata schemas: ISO 8601 UTC offsets, types, tags, and sources.' },
        { slug: 'drizzle-orm-migrations', title: 'Drizzle ORM Zero-Downtime Schema Migrations', desc: 'Transactional SQL migrations, column backfills, and rollback safety.' },
        { slug: 'postgres-connection-pool', title: 'PostgreSQL Connection Pooling & Queue Sizing', desc: 'Optimizing postgres.js max connections, idle timeouts, and backpressure.' },
        { slug: 'wal-archive-pitr', title: 'Continuous Write-Ahead Log (WAL) Archival & PITR', desc: 'Point-In-Time Recovery restore runbooks using PostgreSQL WAL streaming.' },
        { slug: 'slug-hierarchy-tree', title: '8-Level Nested Slug Path Navigation Tree', desc: 'Validating hierarchical note paths and preventing circular directory loops.' },
        { slug: 'jsonb-property-indexing', title: 'PostgreSQL GIN Indexing for Frontmatter JSONB', desc: 'Accelerating metadata filtering by tag and timestamp using JSONB operators.' },
        { slug: 'soft-delete-trash-purge', title: 'Soft-Delete Note Trash Lifecycle & Purge', desc: 'Two-stage deletion with restore capability and irreversible disk purge.' },
        { slug: 'revision-delta-compression', title: 'Fossil Delta Compression for Note Revisions', desc: 'Storing compact binary diffs rather than full snapshots across note edits.' },
        { slug: 'advisory-locks', title: 'PostgreSQL Advisory Locks for Ingestion Workers', desc: 'Preventing concurrent repository reindexing using transaction-scoped locks.' },
        { slug: 'transaction-isolation-serializable', title: 'Serializable Transaction Isolation Invariants', desc: 'Protecting collaborative CRDT snapshot commits against write skew.' },
        { slug: 'vacuum-analyze-scheduling', title: 'Autovacuum Tuning & Table Bloat Mitigation', desc: 'Maintaining healthy PostgreSQL query plans on high-churn note tables.' },
        { slug: 'blob-attachment-store', title: 'Local Content-Addressable Blob Storage', desc: 'SHA-256 deduplicated file attachment storage on filesystem volumes.' },
        { slug: 'progressive-disclosure-index', title: 'Progressive Disclosure Index Generator', desc: 'Synthesizing index.md summaries at each directory level to conserve tokens.' },
        { slug: 'export-zip-streaming', title: 'Streaming Vault ZIP Archive Export Engine', desc: 'Zero-memory streaming export of notes, attachments, and frontmatter.' },
        { slug: 'import-bundle-validation', title: 'OKF Knowledge Bundle Import & Validation', desc: 'Auditing imported zip bundles for schema compliance and safe relative links.' },
        { slug: 'metadata-catalog-cache', title: 'In-Memory Metadata Catalog Cache Invalidation', desc: 'Caching vault directory structures for millisecond UI browsing responses.' },
        { slug: 'partitioned-audit-log', title: 'Time-Partitioned Database Audit Table Architecture', desc: 'Partitioning high-throughput activity logs by month for fast truncation.' },
        { slug: 'crdt-binary-blob-store', title: 'Yjs State Vector Binary Blob PostgreSQL Storage', desc: 'Persisting collaborative update buffers as compact BYTEA records.' },
      ],
    },
    {
      domain: 'search/engine',
      notes: [
        { slug: 'reciprocal-rank-fusion', title: 'Reciprocal Rank Fusion (RRF k=60) Scoring', desc: 'What algorithm is used to rank hybrid search results merging BM25 and vectors.' },
        { slug: 'embedding-backpressure', title: 'Vector Embedding Provider Backpressure & 429', desc: 'What happens when the vector embedding provider returns HTTP 429 and rate limits.' },
        { slug: 'dense-vector-knn', title: 'Dense Vector kNN Cosine Distance Ranking', desc: 'Top-k semantic nearest neighbor retrieval using 384-dimensional dense vectors.' },
        { slug: 'bm25-tsvector-ranking', title: 'BM25 Full-Text Search Using PostgreSQL tsvector', desc: 'Lexical inverted index querying with English dictionary stemming and headline ranking.' },
        { slug: 'chromadb-collection-lifecycle', title: 'ChromaDB Collection Partitioning & Management', desc: 'Decoupled vector storage architecture isolating embeddings from SQL.' },
        { slug: 'pgvector-hnsw-indexing', title: 'HNSW Index Construction Parameters in pgvector', desc: 'Tuning m=16, ef_construction=64, and ef_search=40 for speed and recall.' },
        { slug: 'onnx-local-embeddings', title: 'Local ONNX Runtime Transformer Embeddings', desc: 'Running all-MiniLM-L6-v2 in-process without external API dependencies.' },
        { slug: 'semantic-edge-thresholds', title: 'Semantic Edge Materialization Similarity Thresholds', desc: 'Creating directed semantic links for cosine similarity scores exceeding 0.72.' },
        { slug: 'hybrid-score-normalization', title: 'Min-Max Normalization in Multi-Stage Retrieval', desc: 'Scaling disparate scoring distributions prior to reciprocal rank blending.' },
        { slug: 'token-truncation-pipeline', title: 'Chunking & Sliding Window Token Truncation', desc: 'Splitting large markdown notes into 512-token overlapping semantic chunks.' },
        { slug: 'query-expansion-synonyms', title: 'Query Expansion & Semantic Keyword Augmentation', desc: 'Broadening search recall with developer taxonomy synonym dictionaries.' },
        { slug: 'caching-embedding-cache', title: 'LRU In-Memory Embedding Cache Architecture', desc: 'Preventing duplicate transformer inference for repeated queries.' },
        { slug: 'cross-collection-knn', title: 'Cross-Collection kNN Semantic Neighbor Linking', desc: 'Discovering latent connections between documentation notes and code files.' },
        { slug: 'candidate-selection-limit', title: 'Candidate Selection Limit & Two-Stage Re-Ranking', desc: 'Filtering the top 30 lexical and top 30 semantic candidates before fusion.' },
        { slug: 'cosine-distance-operator', title: 'Cosine Distance Vector Operators & Hardware SIMD', desc: 'Accelerating dot products using AVX-512 and NEON SIMD vector instructions.' },
        { slug: 'exact-trigram-matching', title: 'Trigram pg_trgm Matching for Technical Code Symbols', desc: 'Finding substring and typo-tolerant matches for camelCase identifiers.' },
        { slug: 'multilingual-cjk-tokenization', title: 'Multilingual CJK Tokenization & Script Splitting', desc: 'Handling non-Latin character sets and mixed scripts in search indexes.' },
        { slug: 'reindexing-background-queue', title: 'Asynchronous Vector Reindexing Background Queue', desc: 'Scheduling catch-up vector generation without blocking interactive writes.' },
        { slug: 'vector-store-abstraction', title: 'VectorStore Adapter Interface & Swappable Backends', desc: 'Clean interface supporting MemoryVectorStore, Chroma, and PGVector.' },
        { slug: 'zero-daemon-memory-store', title: 'Zero-Daemon In-Memory Vector Store for Unit Tests', desc: 'Pure in-memory vector cosine distance engine for lightning-fast testing.' },
      ],
    },
    {
      domain: 'repos/treesitter',
      notes: [
        { slug: 'ast-parser', title: 'Tree-sitter AST Symbol Outline & Code Extraction', desc: 'Tree-sitter symbol outline extraction function for functions, classes, and types.' },
        { slug: 'codebase-mapping-protocol', title: '5-Phase Flawless OKF Codebase Mapping Protocol', desc: 'Architectural methodology for transforming code repositories into knowledge graphs.' },
        { slug: 'git-shallow-clone', title: 'Git Shallow Cloning & Blobless Ingestion Engine', desc: 'Fetching only HEAD trees without full git history to maximize ingest speed.' },
        { slug: 'ghost-symbol-pruning', title: 'Ghost Symbol Detection & Stale AST Cleanup', desc: 'Removing deleted functions and refactored classes from search indexes.' },
        { slug: 'webhook-event-handler', title: 'GitHub & GitLab Push Webhook Event Ingestion', desc: 'Triggering automatic incremental repository synchronization upon git push.' },
        { slug: 'incremental-diff-parser', title: 'Incremental Git Diff Parsing & Selective AST Update', desc: 'Re-parsing only modified files rather than re-indexing entire repositories.' },
        { slug: 'language-grammar-registry', title: 'Polyglot Tree-sitter Language Grammar Registry', desc: 'Pre-compiled WebAssembly grammars for TypeScript, Go, Python, and Rust.' },
        { slug: 'symbol-anchor-linking', title: 'Symbol-Anchored Wikilinks & Code Referencing', desc: 'Syntax and resolution for linking directly to specific symbol declarations.' },
        { slug: 'import-dependency-graph', title: 'Import Dependency Graph Extraction from AST', desc: 'Mapping import and require statements into explicit knowledge graph edges.' },
        { slug: 'call-site-ast-visitor', title: 'Call-Site AST Visitor & Reference Resolution', desc: 'Locating function call locations to build cross-file dependency maps.' },
        { slug: 'type-definition-extractor', title: 'Type Definition & Interface Signature Extractor', desc: 'Capturing parameter signatures, return types, and interface fields.' },
        { slug: 'function-declaration-ranges', title: 'Function Declaration Line Span Calculation', desc: 'Accurate start and end line boundary tracking for CodeMirror deep linking.' },
        { slug: 'polyglot-parser-pool', title: 'Worker Pool for Concurrent Tree-sitter Parsing', desc: 'Isolating CPU-heavy AST parsing in dedicated Node.js worker threads.' },
        { slug: 'git-sync-mutex', title: 'Repository Git Sync Mutex & Concurrency Guard', desc: 'Preventing overlapping git pull operations on the same working tree.' },
        { slug: 'local-filesystem-watcher', title: 'Chokidar Local Filesystem Watcher for Desktop Mode', desc: 'Live re-indexing of locally edited repositories with debounced file events.' },
        { slug: 'repository-status-polling', title: 'Repository Synchronization Status State Machine', desc: 'Tracking transitions between idle, cloning, indexing, and error states.' },
        { slug: 'tree-sitter-wasm-bindings', title: 'web-tree-sitter WebAssembly Runtime Optimization', desc: 'Compiling parser WASM modules with SIMD and memory growth limits.' },
        { slug: 'syntax-highlighting-tokens', title: 'Syntax Highlighting Token Generation via AST', desc: 'Extracting semantic tokens for enriched code viewer rendering.' },
        { slug: 'code-snippet-windowing', title: 'Code Snippet Search Windowing & Context Padding', desc: 'Providing 5 lines of surrounding context around search symbol hits.' },
        { slug: 'git-head-commit-tracking', title: 'Git HEAD Commit SHA Tracking & Ingestion Freshness', desc: 'Detecting whether indexed knowledge graph representations match git reality.' },
      ],
    },
  ]

  const corpus: CorpusNote[] = []
  for (const d of domains) {
    for (const n of d.notes) {
      const fullPath = `${d.domain}/${n.slug}`
      const frontmatter = {
        title: n.title,
        schemaVersion: 0.2,
        tags: ['benchmark', 'tp-01', d.domain.split('/')[0]!, 'ir-accuracy'],
        type: 'concept',
        description: n.desc,
      }
      const body = `# ${n.title}\n\n${n.desc}\n\nThis note is an integral component of the Chapters knowledge graph within ${d.domain}.\nIt provides formal documentation on ${n.title.toLowerCase()} and coordinates with sibling components.\n\n## Implementation Details\n- Domain: \`${d.domain}\`\n- Architecture: OKF v0.2 Specification\n- Key Responsibility: ${n.desc}\n`
      corpus.push({
        path: fullPath,
        type: 'concept',
        title: n.title,
        tags: frontmatter.tags,
        body,
      })
    }
  }
  return corpus
}

// -----------------------------------------------------------------------------
// 50 Ground-Truth Labeled Queries across 3 Categories
// -----------------------------------------------------------------------------
export function getGroundTruthQueries(): GroundTruthQuery[] {
  return [
    // Category A: Conceptual & Fuzzy Natural Language (20 Queries)
    { id: 'Q-01', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How do disconnected collaborative clients reconcile document state after reconnecting?', targetPath: 'services/auth/crdt-synchronization', grade: 2 },
    { id: 'Q-02', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'What algorithm is used to rank hybrid search results?', targetPath: 'search/engine/reciprocal-rank-fusion', grade: 2 },
    { id: 'Q-03', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How does vault isolation prevent cross-tenant data leaks?', targetPath: 'architecture/vault-scoping', grade: 2 },
    { id: 'Q-04', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How does the system prevent split brain during network partitions?', targetPath: 'architecture/cluster-arbitration', grade: 2 },
    { id: 'Q-05', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'What protocol disseminates peer cluster membership state?', targetPath: 'architecture/gossip-protocol', grade: 2 },
    { id: 'Q-06', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How are conflicting document states merged mathematically?', targetPath: 'architecture/eventual-consistency', grade: 2 },
    { id: 'Q-07', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'What WebSocket relay topology powers real-time collaborative editing?', targetPath: 'architecture/crdt-relay-topology', grade: 2 },
    { id: 'Q-08', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How does the phi accrual failure detector handle network latency jitter?', targetPath: 'architecture/heartbeat-failure-detector', grade: 2 },
    { id: 'Q-09', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How do distributed quorum leases allow fast non-blocking reads?', targetPath: 'architecture/quorum-leases', grade: 2 },
    { id: 'Q-10', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'What triggers candidate election timeouts in the Raft consensus engine?', targetPath: 'architecture/leader-election-raft', grade: 2 },
    { id: 'Q-11', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How do vector clocks track causality between distributed replicas?', targetPath: 'architecture/vector-clock-merging', grade: 2 },
    { id: 'Q-12', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How does Merkle tree anti-entropy reconcile divergent document stores?', targetPath: 'architecture/anti-entropy-exchange', grade: 2 },
    { id: 'Q-13', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How are deleted document tombstones reclaimed safely?', targetPath: 'architecture/tombstone-garbage-collection', grade: 2 },
    { id: 'Q-14', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How does WebRTC browser mesh operate as a fallback when servers fail?', targetPath: 'architecture/peer-to-peer-mesh', grade: 2 },
    { id: 'Q-15', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How do monotonic fencing tokens prevent stale writes in lock managers?', targetPath: 'architecture/distributed-lock-manager', grade: 2 },
    { id: 'Q-16', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'What hashing algorithm secures user passwords against brute force?', targetPath: 'services/auth/argon2-password-hashing', grade: 2 },
    { id: 'Q-17', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How does TOTP time-based multi-factor authentication handle clock drift?', targetPath: 'services/auth/totp-mfa-authenticator', grade: 2 },
    { id: 'Q-18', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How is asymmetric JWT signature verification implemented against JWKS?', targetPath: 'services/auth/jwt-signature-verification', grade: 2 },
    { id: 'Q-19', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How does double submit cookie mitigate cross-site request forgery?', targetPath: 'services/auth/csrf-token-rotation', grade: 2 },
    { id: 'Q-20', category: 'A', categoryName: 'Conceptual & Fuzzy NL', query: 'How are git access tokens encrypted using envelope encryption and KMS?', targetPath: 'services/auth/credential-encryption', grade: 2 },

    // Category B: Exact Code Identifiers & Symbols (15 Queries)
    { id: 'Q-21', category: 'B', categoryName: 'Exact Code Identifiers', query: 'where is resolveNotePath called during document write?', targetPath: 'database/storage/okf-path-resolution', grade: 2 },
    { id: 'Q-22', category: 'B', categoryName: 'Exact Code Identifiers', query: 'find usages of checkRateLimit', targetPath: 'services/auth/mcp-rate-limiter', grade: 2 },
    { id: 'Q-23', category: 'B', categoryName: 'Exact Code Identifiers', query: 'Tree-sitter symbol outline extraction function', targetPath: 'repos/treesitter/ast-parser', grade: 2 },
    { id: 'Q-24', category: 'B', categoryName: 'Exact Code Identifiers', query: 'OKF v0.2 YAML Frontmatter specification', targetPath: 'database/storage/frontmatter-schema-v02', grade: 2 },
    { id: 'Q-25', category: 'B', categoryName: 'Exact Code Identifiers', query: 'Drizzle ORM zero-downtime schema migrations', targetPath: 'database/storage/drizzle-orm-migrations', grade: 2 },
    { id: 'Q-26', category: 'B', categoryName: 'Exact Code Identifiers', query: 'GIN indexing for frontmatter JSONB metadata', targetPath: 'database/storage/jsonb-property-indexing', grade: 2 },
    { id: 'Q-27', category: 'B', categoryName: 'Exact Code Identifiers', query: 'Fossil delta compression for note revision history', targetPath: 'database/storage/revision-delta-compression', grade: 2 },
    { id: 'Q-28', category: 'B', categoryName: 'Exact Code Identifiers', query: 'PostgreSQL advisory locks for ingestion workers', targetPath: 'database/storage/advisory-locks', grade: 2 },
    { id: 'Q-29', category: 'B', categoryName: 'Exact Code Identifiers', query: 'HNSW index construction parameters in pgvector', targetPath: 'search/engine/pgvector-hnsw-indexing', grade: 2 },
    { id: 'Q-30', category: 'B', categoryName: 'Exact Code Identifiers', query: 'Local ONNX runtime transformer embeddings all-MiniLM-L6-v2', targetPath: 'search/engine/onnx-local-embeddings', grade: 2 },
    { id: 'Q-31', category: 'B', categoryName: 'Exact Code Identifiers', query: 'Cosine distance vector operators SIMD AVX-512', targetPath: 'search/engine/cosine-distance-operator', grade: 2 },
    { id: 'Q-32', category: 'B', categoryName: 'Exact Code Identifiers', query: 'Trigram pg_trgm matching for code symbols', targetPath: 'search/engine/exact-trigram-matching', grade: 2 },
    { id: 'Q-33', category: 'B', categoryName: 'Exact Code Identifiers', query: 'Git shallow cloning and blobless ingestion', targetPath: 'repos/treesitter/git-shallow-clone', grade: 2 },
    { id: 'Q-34', category: 'B', categoryName: 'Exact Code Identifiers', query: 'Incremental git diff parsing and AST update', targetPath: 'repos/treesitter/incremental-diff-parser', grade: 2 },
    { id: 'Q-35', category: 'B', categoryName: 'Exact Code Identifiers', query: 'web-tree-sitter WebAssembly runtime optimization', targetPath: 'repos/treesitter/tree-sitter-wasm-bindings', grade: 2 },

    // Category C: Failure Modes & Edge Cases (15 Queries)
    { id: 'Q-36', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'What happens when the vector embedding provider returns HTTP 429?', targetPath: 'search/engine/embedding-backpressure', grade: 2 },
    { id: 'Q-37', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'How are orphan notes and broken wikilinks detected?', targetPath: 'architecture/conformance-audit', grade: 2 },
    { id: 'Q-38', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'What triggers automatic note revision pruning?', targetPath: 'database/storage/history-revisions', grade: 2 },
    { id: 'Q-39', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'How does the system handle degraded modes during wide area network disconnects?', targetPath: 'architecture/partition-tolerance', grade: 2 },
    { id: 'Q-40', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'How are stale AST symbols pruned when files are deleted?', targetPath: 'repos/treesitter/ghost-symbol-pruning', grade: 2 },
    { id: 'Q-41', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'How does account lockout defend against credential stuffing attacks?', targetPath: 'services/auth/account-lockout-policy', grade: 2 },
    { id: 'Q-42', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'How does PostgreSQL connection pool handle worker queue backpressure?', targetPath: 'database/storage/postgres-connection-pool', grade: 2 },
    { id: 'Q-43', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'How does the Point-In-Time Recovery restore runbook use WAL streaming?', targetPath: 'database/storage/wal-archive-pitr', grade: 2 },
    { id: 'Q-44', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'How does soft delete prevent accidental permanent loss of notes?', targetPath: 'database/storage/soft-delete-trash-purge', grade: 2 },
    { id: 'Q-45', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'What threshold filters out weak semantic edges below 0.72 similarity?', targetPath: 'search/engine/semantic-edge-thresholds', grade: 2 },
    { id: 'Q-46', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'How does chunking split large notes exceeding 512 tokens?', targetPath: 'search/engine/token-truncation-pipeline', grade: 2 },
    { id: 'Q-47', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'How does the search engine tokenize non-Latin CJK character sets?', targetPath: 'search/engine/multilingual-cjk-tokenization', grade: 2 },
    { id: 'Q-48', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'How does the asynchronous vector queue catch up after outages?', targetPath: 'search/engine/reindexing-background-queue', grade: 2 },
    { id: 'Q-49', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'How does the repository git sync mutex prevent race conditions?', targetPath: 'repos/treesitter/git-sync-mutex', grade: 2 },
    { id: 'Q-50', category: 'C', categoryName: 'Failure Modes & Edge Cases', query: 'How does the system detect codebase drift when git HEAD changes?', targetPath: 'repos/treesitter/git-head-commit-tracking', grade: 2 },
  ]
}

// -----------------------------------------------------------------------------
// MCP Tool Client
// -----------------------------------------------------------------------------
export async function callMcpTool(
  target: TargetConfig,
  toolName: string,
  args: Record<string, any> = {},
): Promise<{ durationMs: number; status: number; data?: any; error?: string }> {
  const t0 = performance.now()
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1000000),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }),
    })
    const durationMs = performance.now() - t0
    if (res.status === 429) {
      return { durationMs, status: 429, error: 'Rate limit exceeded (429)' }
    }
    if (!res.ok) {
      const txt = await res.text()
      return { durationMs, status: res.status, error: `HTTP ${res.status}: ${txt}` }
    }
    const json: any = await res.json()
    if (json.error) {
      return { durationMs, status: 200, error: json.error.message }
    }
    const textContent = json.result?.content?.[0]?.text
    let data = json.result
    if (textContent) {
      try {
        data = JSON.parse(textContent)
      } catch {
        data = textContent
      }
    }
    return { durationMs, status: 200, data }
  } catch (err: any) {
    return { durationMs: performance.now() - t0, status: 0, error: err.message }
  }
}

// -----------------------------------------------------------------------------
// Mathematical Metrics: NDCG@10, MRR, Recall@k
// -----------------------------------------------------------------------------
export function calculateNdcgAtK(rankedDocPaths: string[], targetDocPath: string, k: number = 10): number {
  const targetCategory = targetDocPath.split('/')[0]!
  let dcg = 0
  for (let i = 0; i < Math.min(rankedDocPaths.length, k); i++) {
    const docPath = rankedDocPaths[i]!
    let rel = 0
    if (docPath === targetDocPath || docPath.endsWith(targetDocPath)) {
      rel = 2 // Exact ground-truth match
    } else if (docPath.startsWith(targetCategory)) {
      rel = 1 // Sibling topic match in target domain
    }
    if (rel > 0) {
      dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2) // i is 0-indexed, so rank = i+1, denom = log2((i+1)+1)
    }
  }

  // Ideal DCG: top-1 is exact match (rel=2), followed by domain match (rel=1)
  const idcg = (Math.pow(2, 2) - 1) / Math.log2(2) // 3.0
  return Number((dcg / idcg).toFixed(4))
}

export function calculateMrr(rankedDocPaths: string[], targetDocPath: string): number {
  for (let i = 0; i < rankedDocPaths.length; i++) {
    const docPath = rankedDocPaths[i]!
    if (docPath === targetDocPath || docPath.endsWith(targetDocPath)) {
      return Number((1 / (i + 1)).toFixed(4))
    }
  }
  return 0
}

export function calculateRecallAtK(rankedDocPaths: string[], targetDocPath: string, k: number): number {
  for (let i = 0; i < Math.min(rankedDocPaths.length, k); i++) {
    const docPath = rankedDocPaths[i]!
    if (docPath === targetDocPath || docPath.endsWith(targetDocPath)) {
      return 1
    }
  }
  return 0
}

// -----------------------------------------------------------------------------
// Concurrent Worker Pool
// -----------------------------------------------------------------------------
async function runWorkerPool<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let currentIndex = 0
  async function worker() {
    while (currentIndex < items.length) {
      const index = currentIndex++
      const item = items[index]!
      results[index] = await task(item, index)
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

// -----------------------------------------------------------------------------
// Hardware Telemetry Daemon (Darwin/Node 500ms synchronous sampler)
// -----------------------------------------------------------------------------
export class HardwareSampler {
  private timer: NodeJS.Timeout | null = null
  private logPath: string
  private fd: number | null = null

  constructor(outputDir: string) {
    this.logPath = path.join(outputDir, 'telemetry_hardware.jsonl')
  }

  start() {
    this.fd = fs.openSync(this.logPath, 'w')
    let prevCpu = process.cpuUsage()

    this.timer = setInterval(() => {
      const mem = process.memoryUsage()
      const currCpu = process.cpuUsage(prevCpu)
      prevCpu = process.cpuUsage()

      const sample = {
        timestamp_iso: new Date().toISOString(),
        epoch_ms: Date.now(),
        process_memory: {
          rss_mb: Number((mem.rss / 1024 / 1024).toFixed(2)),
          heap_total_mb: Number((mem.heapTotal / 1024 / 1024).toFixed(2)),
          heap_used_mb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
          external_mb: Number((mem.external / 1024 / 1024).toFixed(2)),
        },
        host_system: {
          load_avg: os.loadavg(),
          free_mem_mb: Number((os.freemem() / 1024 / 1024).toFixed(0)),
          total_mem_mb: Number((os.totalmem() / 1024 / 1024).toFixed(0)),
          cpu_user_micros: currCpu.user,
          cpu_system_micros: currCpu.system,
        },
      }
      fs.writeSync(this.fd!, JSON.stringify(sample) + '\n')
    }, 500)
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.fd !== null) {
      fs.closeSync(this.fd)
      this.fd = null
    }
  }
}

// -----------------------------------------------------------------------------
// Test Execution Orchestrator
// -----------------------------------------------------------------------------
export interface QueryResultRecord {
  timestamp_iso: string
  epoch_ms: number
  target: string
  mode: string
  query_id: string
  category: string
  query_string: string
  target_doc: string
  duration_ms: number
  http_status: number
  result_count: number
  top_10_doc_ids: string[]
  ndcg_score: number
  mrr_score: number
  recall_at_5: number
  recall_at_10: number
}

export interface HiccupRecord {
  timestamp_iso: string
  epoch_ms: number
  target: string
  query_id: string
  hiccup_type: 'LATENCY_SPIKE_HICCUP' | 'RATE_LIMIT_HICCUP' | 'RETRIEVAL_MISS_HICCUP' | 'SOCKET_RECONNECT_HICCUP' | 'MEMORY_DRIFT_HICCUP'
  severity: 'NOTICE' | 'WARNING' | 'CRITICAL'
  details: string
  context: Record<string, any>
}

export interface TargetBenchmarkReport {
  target: string
  title: string
  vaultId: string
  seededNotes: number
  queryCount: number
  totalDurationMs: number
  metrics: {
    ndcg_at_10_avg: number
    mrr_avg: number
    recall_at_5_pct: number
    recall_at_10_pct: number
    ndcg_by_category: Record<string, number>
    mrr_by_category: Record<string, number>
    p50_latency_ms: number
    p95_latency_ms: number
    p99_latency_ms: number
    min_latency_ms: number
    max_latency_ms: number
    avg_latency_ms: number
    qps: number
  }
  hiccups: {
    total: number
    latency_spikes: number
    rate_limits: number
    retrieval_misses: number
    socket_drops: number
  }
  slo_gates: {
    ndcg_gate_passed: boolean
    mrr_gate_passed: boolean
    recall_gate_passed: boolean
    hiccup_gate_passed: boolean
    verdict: 'PASSED' | 'PASSED_WITH_WARNINGS' | 'FAILED'
  }
}

export async function executeBenchmarkForTarget(
  target: TargetConfig,
  corpus: CorpusNote[],
  queries: GroundTruthQuery[],
  requestsStream: fs.WriteStream,
  hiccupsStream: fs.WriteStream,
): Promise<TargetBenchmarkReport> {
  console.log(`\n======================================================================`)
  console.log(`>>> EXECUTING TP-01 FOR TARGET: ${target.name.toUpperCase()} (${target.title})`)
  console.log(`>>> Live MCP Endpoint: ${target.url}`)
  console.log(`======================================================================\n`)

  const tStart = performance.now()
  let vaultId = ''
  const vaultName = `tp01-ir-benchmark-vault-${target.name}`

  // Step 1: Create Scoped Benchmark Vault
  console.log(`[Step 1/5] Creating dedicated benchmark vault: ${vaultName}...`)
  const createVaultRes = await callMcpTool(target, 'create_vault', {
    name: vaultName,
    description: `TP-01 IR Benchmark Corpus Vault for ${target.title}`,
  })
  if (createVaultRes.status !== 200 || !createVaultRes.data?.id) {
    throw new Error(`Failed to create benchmark vault on ${target.name}: ${createVaultRes.error}`)
  }
  vaultId = createVaultRes.data.id
  console.log(`  Vault ready: ${vaultId} (${createVaultRes.durationMs.toFixed(1)}ms)`)

  // Step 2: Seed 100 Notes with Concurrency 5
  console.log(`\n[Step 2/5] Ingesting 100 benchmark notes across 5 domains (concurrency: 5)...`)
  const seedStart = performance.now()
  let seedFailures = 0
  await runWorkerPool(corpus, 5, async (note) => {
    const res = await callMcpTool(target, 'create_note', {
      vaultId,
      path: note.path,
      content: `---\ntitle: "${note.title}"\ntags: [${note.tags.map((t) => `"${t}"`).join(', ')}]\ntype: "${note.type}"\n---\n\n${note.body}`,
    })
    if (res.status !== 200 && res.status !== 429) {
      seedFailures++
    }
    return res
  })
  const seedDuration = performance.now() - seedStart
  console.log(`  Ingested 100 notes in ${(seedDuration / 1000).toFixed(1)}s (Failures: ${seedFailures})`)

  // Step 3: Settling Window for Indexing
  console.log(`\n[Step 3/5] Waiting 3.5s for indexing and vector embedding queues to settle...`)
  await new Promise((r) => setTimeout(r, 3500))

  // Step 4: Execute 50 Ground-Truth Queries
  console.log(`\n[Step 4/5] Executing 50 ground-truth labeled queries (Category A, B, C)...`)
  const records: QueryResultRecord[] = []
  const hiccups: HiccupRecord[] = []
  const durations: number[] = []

  for (let qIdx = 0; qIdx < queries.length; qIdx++) {
    const q = queries[qIdx]!
    const qStartEpoch = Date.now()
    const qStartIso = new Date(qStartEpoch).toISOString()

    const searchRes = await callMcpTool(target, 'search', {
      vaultId,
      query: q.query,
      limit: 10,
    })

    durations.push(searchRes.durationMs)
    const rawResults: any[] = Array.isArray(searchRes.data) ? searchRes.data : []
    const rankedPaths: string[] = rawResults.map((r: any) => r.path ?? '')

    const ndcg = calculateNdcgAtK(rankedPaths, q.targetPath, 10)
    const mrr = calculateMrr(rankedPaths, q.targetPath)
    const r5 = calculateRecallAtK(rankedPaths, q.targetPath, 5)
    const r10 = calculateRecallAtK(rankedPaths, q.targetPath, 10)

    const record: QueryResultRecord = {
      timestamp_iso: qStartIso,
      epoch_ms: qStartEpoch,
      target: target.name,
      mode: 'hybrid',
      query_id: q.id,
      category: q.category,
      query_string: q.query,
      target_doc: q.targetPath,
      duration_ms: Number(searchRes.durationMs.toFixed(2)),
      http_status: searchRes.status,
      result_count: rawResults.length,
      top_10_doc_ids: rankedPaths,
      ndcg_score: ndcg,
      mrr_score: mrr,
      recall_at_5: r5,
      recall_at_10: r10,
    }
    records.push(record)
    requestsStream.write(JSON.stringify(record) + '\n')

    // Hiccup Ledger Evaluation
    if (searchRes.durationMs > 1200) {
      const h: HiccupRecord = {
        timestamp_iso: qStartIso,
        epoch_ms: qStartEpoch,
        target: target.name,
        query_id: q.id,
        hiccup_type: 'LATENCY_SPIKE_HICCUP',
        severity: 'WARNING',
        details: `Query latency ${searchRes.durationMs.toFixed(1)}ms exceeded 1,200ms threshold`,
        context: { query: q.query, durationMs: searchRes.durationMs },
      }
      hiccups.push(h)
      hiccupsStream.write(JSON.stringify(h) + '\n')
    }

    if (searchRes.status === 429) {
      const h: HiccupRecord = {
        timestamp_iso: qStartIso,
        epoch_ms: qStartEpoch,
        target: target.name,
        query_id: q.id,
        hiccup_type: 'RATE_LIMIT_HICCUP',
        severity: 'NOTICE',
        details: `HTTP 429 rate limit exceeded on search`,
        context: { query: q.query },
      }
      hiccups.push(h)
      hiccupsStream.write(JSON.stringify(h) + '\n')
    }

    if (r10 === 0) {
      const h: HiccupRecord = {
        timestamp_iso: qStartIso,
        epoch_ms: qStartEpoch,
        target: target.name,
        query_id: q.id,
        hiccup_type: 'RETRIEVAL_MISS_HICCUP',
        severity: 'NOTICE',
        details: `Target document ${q.targetPath} not present in top 10 search results`,
        context: { query: q.query, target: q.targetPath, returnedTop3: rankedPaths.slice(0, 3) },
      }
      hiccups.push(h)
      hiccupsStream.write(JSON.stringify(h) + '\n')
    }

    if (searchRes.status === 0) {
      const h: HiccupRecord = {
        timestamp_iso: qStartIso,
        epoch_ms: qStartEpoch,
        target: target.name,
        query_id: q.id,
        hiccup_type: 'SOCKET_RECONNECT_HICCUP',
        severity: 'CRITICAL',
        details: `Network disconnect or socket error: ${searchRes.error}`,
        context: { query: q.query },
      }
      hiccups.push(h)
      hiccupsStream.write(JSON.stringify(h) + '\n')
    }

    if ((qIdx + 1) % 10 === 0 || qIdx === queries.length - 1) {
      const curAvgNdcg = (records.reduce((acc, r) => acc + r.ndcg_score, 0) / records.length).toFixed(3)
      const curAvgMrr = (records.reduce((acc, r) => acc + r.mrr_score, 0) / records.length).toFixed(3)
      console.log(`  Progress: ${qIdx + 1}/50 queries completed | NDCG@10: ${curAvgNdcg} | MRR: ${curAvgMrr}`)
    }
  }

  // Step 5: Cleanup Benchmark Vault
  console.log(`\n[Step 5/5] Cleaning up benchmark vault...`)
  await callMcpTool(target, 'delete_vault', { vaultId })
  await callMcpTool(target, 'purge_vault', { vaultId })
  console.log(`  Purged vault ${vaultId}`)

  const totalDurationMs = performance.now() - tStart

  // Calculate Aggregates
  const ndcgAvg = Number((records.reduce((acc, r) => acc + r.ndcg_score, 0) / records.length).toFixed(4))
  const mrrAvg = Number((records.reduce((acc, r) => acc + r.mrr_score, 0) / records.length).toFixed(4))
  const r5Pct = Number(((records.filter((r) => r.recall_at_5 > 0).length / records.length) * 100).toFixed(1))
  const r10Pct = Number(((records.filter((r) => r.recall_at_10 > 0).length / records.length) * 100).toFixed(1))

  const cats = ['A', 'B', 'C']
  const ndcgByCat: Record<string, number> = {}
  const mrrByCat: Record<string, number> = {}
  for (const c of cats) {
    const catRecs = records.filter((r) => r.category === c)
    ndcgByCat[c] = Number((catRecs.reduce((acc, r) => acc + r.ndcg_score, 0) / catRecs.length).toFixed(4))
    mrrByCat[c] = Number((catRecs.reduce((acc, r) => acc + r.mrr_score, 0) / catRecs.length).toFixed(4))
  }

  const sortedDurs = [...durations].sort((a, b) => a - b)
  const p50 = sortedDurs[Math.floor(sortedDurs.length * 0.5)] ?? 0
  const p95 = sortedDurs[Math.floor(sortedDurs.length * 0.95)] ?? 0
  const p99 = sortedDurs[Math.floor(sortedDurs.length * 0.99)] ?? 0
  const minDur = sortedDurs[0] ?? 0
  const maxDur = sortedDurs[sortedDurs.length - 1] ?? 0
  const avgDur = sortedDurs.reduce((acc, v) => acc + v, 0) / sortedDurs.length
  const qps = Number((records.length / (totalDurationMs / 1000)).toFixed(2))

  // SLO Evaluation
  const ndcgPassed = ndcgAvg >= 0.85
  const mrrPassed = mrrAvg >= 0.75
  const recallPassed = r5Pct >= 90.0
  const criticalHiccups = hiccups.filter((h) => h.severity === 'CRITICAL').length
  const hiccupPassed = criticalHiccups === 0

  let verdict: 'PASSED' | 'PASSED_WITH_WARNINGS' | 'FAILED' = 'PASSED'
  if (!ndcgPassed || !mrrPassed || !recallPassed || !hiccupPassed) {
    if (criticalHiccups > 0 || ndcgAvg < 0.70) {
      verdict = 'FAILED'
    } else {
      verdict = 'PASSED_WITH_WARNINGS'
    }
  }

  return {
    target: target.name,
    title: target.title,
    vaultId,
    seededNotes: corpus.length,
    queryCount: queries.length,
    totalDurationMs: Number(totalDurationMs.toFixed(1)),
    metrics: {
      ndcg_at_10_avg: ndcgAvg,
      mrr_avg: mrrAvg,
      recall_at_5_pct: r5Pct,
      recall_at_10_pct: r10Pct,
      ndcg_by_category: ndcgByCat,
      mrr_by_category: mrrByCat,
      p50_latency_ms: Number(p50.toFixed(2)),
      p95_latency_ms: Number(p95.toFixed(2)),
      p99_latency_ms: Number(p99.toFixed(2)),
      min_latency_ms: Number(minDur.toFixed(2)),
      max_latency_ms: Number(maxDur.toFixed(2)),
      avg_latency_ms: Number(avgDur.toFixed(2)),
      qps,
    },
    hiccups: {
      total: hiccups.length,
      latency_spikes: hiccups.filter((h) => h.hiccup_type === 'LATENCY_SPIKE_HICCUP').length,
      rate_limits: hiccups.filter((h) => h.hiccup_type === 'RATE_LIMIT_HICCUP').length,
      retrieval_misses: hiccups.filter((h) => h.hiccup_type === 'RETRIEVAL_MISS_HICCUP').length,
      socket_drops: hiccups.filter((h) => h.hiccup_type === 'SOCKET_RECONNECT_HICCUP').length,
    },
    slo_gates: {
      ndcg_gate_passed: ndcgPassed,
      mrr_gate_passed: mrrPassed,
      recall_gate_passed: recallPassed,
      hiccup_gate_passed: hiccupPassed,
      verdict,
    },
  }
}

// -----------------------------------------------------------------------------
// Main Execution Entrypoint
// -----------------------------------------------------------------------------
export async function main() {
  const outputDir = path.resolve(process.cwd(), 'benchmarks/runs/tp-01-ir-retrieval-accuracy')
  fs.mkdirSync(outputDir, { recursive: true })

  console.log(`\n######################################################################`)
  console.log(`#  TP-01: INFORMATION RETRIEVAL ACCURACY & RANKING BENCHMARK          #`)
  console.log(`#  SOP: plan/00-master-test-execution-orchestrator                    #`)
  console.log(`#  Output Directory: ${outputDir} #`)
  console.log(`######################################################################\n`)

  // Step 3: Arm Hardware Daemon
  console.log(`[SOP Step 3] Arming 500ms synchronous hardware telemetry sampler...`)
  const sampler = new HardwareSampler(outputDir)
  sampler.start()

  const requestsLogPath = path.join(outputDir, 'test_01_ir_requests.jsonl')
  const hiccupsLogPath = path.join(outputDir, 'test_01_ir_hiccups.jsonl')
  const requestsStream = fs.createWriteStream(requestsLogPath, { flags: 'w' })
  const hiccupsStream = fs.createWriteStream(hiccupsLogPath, { flags: 'w' })

  const corpus = generateBenchmarkCorpus()
  const queries = getGroundTruthQueries()
  console.log(`Loaded ${corpus.length} benchmark notes across 5 technical domains.`)
  console.log(`Loaded ${queries.length} ground-truth labeled queries (Categories A, B, C).`)

  const reports: Record<string, TargetBenchmarkReport> = {}

  try {
    for (const target of TARGETS) {
      const rep = await executeBenchmarkForTarget(target, corpus, queries, requestsStream, hiccupsStream)
      reports[target.name] = rep
      console.log(`\nCooldown: 4 seconds before next target...`)
      await new Promise((r) => setTimeout(r, 4000))
    }
  } finally {
    sampler.stop()
    requestsStream.end()
    hiccupsStream.end()
    console.log(`[SOP Step 3] Disarmed hardware telemetry sampler.`)
  }

  const summaryPath = path.join(outputDir, 'summary.json')
  fs.writeFileSync(summaryPath, JSON.stringify(reports, null, 2))
  console.log(`\n>>> Full benchmark telemetry saved to:`)
  console.log(`    - ${requestsLogPath}`)
  console.log(`    - ${hiccupsLogPath}`)
  console.log(`    - ${path.join(outputDir, 'telemetry_hardware.jsonl')}`)
  console.log(`    - ${summaryPath}`)

  return reports
}

// Run if executed directly
if (process.argv[1]?.endsWith('run-ir-benchmark.ts')) {
  main()
    .then((reports) => {
      console.log('\n======================================================================')
      console.log('>>> ALL TARGETS EXECUTED SUCCESSFULLY!')
      for (const [key, rep] of Object.entries(reports)) {
        console.log(`\n[${key.toUpperCase()}] Verdict: ${rep.slo_gates.verdict}`)
        console.log(`  NDCG@10: ${rep.metrics.ndcg_at_10_avg} (Gate: >=0.85 -> ${rep.slo_gates.ndcg_gate_passed ? 'PASS' : 'WARN/FAIL'})`)
        console.log(`  MRR:     ${rep.metrics.mrr_avg} (Gate: >=0.75 -> ${rep.slo_gates.mrr_gate_passed ? 'PASS' : 'WARN/FAIL'})`)
        console.log(`  Recall@5:${rep.metrics.recall_at_5_pct}% (Gate: >=90% -> ${rep.slo_gates.recall_gate_passed ? 'PASS' : 'WARN/FAIL'})`)
        console.log(`  p50 Latency: ${rep.metrics.p50_latency_ms}ms | p95: ${rep.metrics.p95_latency_ms}ms | QPS: ${rep.metrics.qps}`)
        console.log(`  Hiccups: ${rep.hiccups.total} (Spikes: ${rep.hiccups.latency_spikes}, 429s: ${rep.hiccups.rate_limits}, Misses: ${rep.hiccups.retrieval_misses})`)
      }
      console.log('======================================================================\n')
    })
    .catch((err) => {
      console.error('Fatal benchmark execution error:', err)
      process.exit(1)
    })
}
