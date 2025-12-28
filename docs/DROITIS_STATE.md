Phase 1 : RAG branché Supabase via RPC DEV search_legal_vectors_dev, table legal_vectors_dev

Phase 2 : Auth Supabase Next (login/signup/reset), /app et /diag protégés

Tables “par user” : profiles, subscriptions, customers, logs (RLS actif)

Endpoints existants : /api/chat

Endpoints à créer Phase 3 : /api/me/subscription, webhook /api/stripe/webhook

Contraintes :

front = anon key seulement

service_role = serveur seulement

pas de secrets dans Knowledge