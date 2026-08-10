app-gestao-tarefas

App de gestao de tarefas (front-end estatico, hospedado no Netlify).

Arquivos:
index.html = codigo-fonte do app (Firebase Auth + Firestore).
netlify-snippets/ = copias de referencia dos 4 snippets configurados no Netlify (Site settings, Build and deploy, Post processing, Snippet injection). Sao apenas documentacao, o Netlify injeta o conteudo real automaticamente.

Deploy: conectado ao Netlify via GitHub. Qualquer commit ou push na branch main dispara um novo deploy automatico em producao.
