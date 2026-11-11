BANNER & BLADE MULTIPLAYER UPDATE - GITHUB UPLOAD LAYOUT

Upload the contents of this package into the ROOT of the existing
banner-and-blade GitHub repository (main branch).

This package is arranged so that:
- index.html updates the GitHub Pages game website.
- server/ contains the Node.js multiplayer server.
- render.yaml is at repository root and configures Render Blueprint deployment
  with rootDir: server.

Do not upload this ZIP as one file. Extract it first, then upload the files
and folders inside it to the repository root. Keep existing repository files
unless a same-named file is intentionally being replaced.

Render can also be configured manually as a Web Service:
- Repository: Bob-Jefferson1824/banner-and-blade
- Branch: main
- Root Directory: server
- Build Command: npm install
- Start Command: npm start
- Environment Variable: ALLOWED_ORIGINS=https://bob-jefferson1824.github.io

The game client needs the Render service URL in Online Play, or in the game
URL as ?server=https://YOUR-SERVICE.onrender.com.
