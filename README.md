# Docs Crawler MCP Server

This project implements a Model Context Protocol (MCP) server that allows you to crawl documentation websites, store the content locally, and search through it using vector embeddings.

---

## ![image](https://github.com/user-attachments/assets/fc3ff083-f786-4a80-a726-9e0d376a5b58)

## Features

This server provides two main tools accessible via MCP:

1.  **`crawl-docs-website`**:

    - Crawls a given documentation website up to a depth of 2 levels using Breadth-First Search (BFS).
    - Extracts the main text content from each page.
    - Chunks the text into manageable pieces (approx. 6000 characters).
    - Generates simple TF-IDF based embeddings for each chunk.
    - Stores the raw text chunks as JSON files locally in `./data/<site_slug>` and `~/crawled-docs/<site_slug>`.
    - Stores the chunks and their corresponding vectors in a local Qdrant vector database collection named `<site_slug>`.
    - Includes an option (`forceRecrawl`) to clear existing data before crawling.

2.  **`search-docs`**:
    - Takes a base URL (corresponding to a previously crawled site) and one or more search queries.
    - Generates an embedding for each query.
    - Performs a vector similarity search against the relevant Qdrant collection.
    - Returns the top relevant text chunks (with source URL and score) for each query.
    - Includes a fallback to simple text search on the stored JSON files if vector search fails or yields no results.

## Requirements

- **Node.js:** Version 18 or later recommended.
- **npm:** Node Package Manager (usually comes with Node.js).
- **Python & pip:** Required for the `unstructured` library. Ensure Python and pip are installed and accessible in your system's PATH.
- **Unstructured:** A Python library used for document parsing. Install it via pip: `pip install unstructured`.
- **Qdrant:** A running instance of the Qdrant vector database. The server defaults to connecting to `http://localhost:6333`.

**Note on PATH:** The MCP server process needs to be able to find the `unstructured` command. If you encounter "'unstructured' is not recognized" errors, you may need to manually add the Python `Scripts` directory (where pip installs executables) to the `PATH` environment variable within the server's configuration in your `cline_mcp_settings.json` or `claude_desktop_config.json` file, similar to this:

```json
"env": {
  "PATH": "C:/path/to/your/Python/Scripts;${env:PATH}"
  // ... other env vars
}
```

## Setup

1.  **Clone the Repository:**

    ```bash
    git clone <repository_url>
    cd docs-tool
    ```

    _(Replace `<repository_url>` if applicable, otherwise assume you are already in the `docs-tool` directory)_

2.  **Install Dependencies:**

    ```bash
    npm install
    ```

3.  **Run Qdrant:**
    The easiest way to run Qdrant locally is using Docker:

    ```bash
    docker run -p 6333:6333 -p 6334:6334 \
        -v $(pwd)/qdrant_storage:/qdrant/storage:z \
        qdrant/qdrant
    ```

    This command starts Qdrant and maps its ports to your local machine. It also persists data in a `qdrant_storage` directory within your project folder.

4.  **Build the Project:**
    Compile the TypeScript code into JavaScript:
    ```bash
    npm run build
    ```
    This will create a `build` directory containing the executable `index.js` file.

## MCP Server Configuration

To use this server with an MCP client (like Cline), you need to add its configuration to your MCP settings file. This file is typically located at:

- **Cline (VS Code Extension):** `c:\Users\<YourUsername>\AppData\Roaming\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- **Claude Desktop App (Windows):** `c:\Users\<YourUsername>\AppData\Roaming\Claude\claude_desktop_config.json`

Add the following entry to the `mcpServers` object in the settings file. **Make sure to replace `<absolute_path_to_docs_tool>` with the actual absolute path to this project's directory on your system.**

```json
{
  "mcpServers": {
    // ... other servers might be here ...
    "docs-crawler": {
      "command": "node",
      "args": ["<absolute_path_to_docs_tool>/build/index.js"],
      "env": {},
      "disabled": false,
      "autoApprove": [],
      "timeout": 300000 // add this -> crawler uses puppeteer so it takes some time.
    }
    // ... other servers might be here ...
  }
}
```

**Example `args` path on Windows:** `C:/Users/yazan/Documents/Cline/MCP/docs-tool/build/index.js` (Use forward slashes).

After saving the settings file, the MCP client should automatically detect and connect to the `docs-crawler` server.

## Usage

Once the server is configured and running, you can use its tools through your MCP client.

**Example 1: Crawl a Website**

```
Use the 'crawl-docs-website' tool from the 'docs-crawler' server with baseUrl 'https://react.dev/learn'
```

_(You can add `forceRecrawl: true` if needed)_

**Example 2: Search the Crawled Content**

```
Use the 'search-docs' tool from the 'docs-crawler' server with baseUrl 'https://react.dev/learn' and queries ['what are react hooks?', 'explain useState']
```

The server will return the search results, including the relevant text chunks, their source URLs, and similarity scores.

## Data Storage

- **Raw Chunks:** Stored as JSON files in `./data/<site_slug>` within the project directory and also mirrored in `C:/Users/<YourUsername>/crawled-docs/<site_slug>`.
- **Embeddings:** Stored in the Qdrant vector database in a collection named `<site_slug>`.

## Limitations

- **Simple Embeddings:** Uses a basic TF-IDF approach for embeddings, which might be less accurate than sophisticated models like Sentence Transformers.
- **Crawl Depth:** Limited to a depth of 2 from the base URL.
- **Error Handling:** Basic error handling is implemented, but complex crawl scenarios might require more robust handling.
