[
  {
    "table_name": "customers",
    "column_name": "user_id",
    "data_type": "uuid",
    "is_nullable": "NO"
  },
  {
    "table_name": "customers",
    "column_name": "customer_id",
    "data_type": "text",
    "is_nullable": "NO"
  },
  {
    "table_name": "logs",
    "column_name": "id",
    "data_type": "bigint",
    "is_nullable": "NO"
  },
  {
    "table_name": "logs",
    "column_name": "question",
    "data_type": "text",
    "is_nullable": "YES"
  },
  {
    "table_name": "logs",
    "column_name": "profile_slug",
    "data_type": "text",
    "is_nullable": "YES"
  },
  {
    "table_name": "logs",
    "column_name": "top_ids",
    "data_type": "jsonb",
    "is_nullable": "YES"
  },
  {
    "table_name": "logs",
    "column_name": "response",
    "data_type": "jsonb",
    "is_nullable": "YES"
  },
  {
    "table_name": "logs",
    "column_name": "usage",
    "data_type": "jsonb",
    "is_nullable": "YES"
  },
  {
    "table_name": "logs",
    "column_name": "created_at",
    "data_type": "timestamp with time zone",
    "is_nullable": "YES"
  },
  {
    "table_name": "logs",
    "column_name": "user_id",
    "data_type": "uuid",
    "is_nullable": "YES"
  },
  {
    "table_name": "profiles",
    "column_name": "id",
    "data_type": "uuid",
    "is_nullable": "NO"
  },
  {
    "table_name": "profiles",
    "column_name": "created_at",
    "data_type": "timestamp with time zone",
    "is_nullable": "YES"
  },
  {
    "table_name": "subscriptions",
    "column_name": "user_id",
    "data_type": "uuid",
    "is_nullable": "NO"
  },
  {
    "table_name": "subscriptions",
    "column_name": "customer_id",
    "data_type": "text",
    "is_nullable": "YES"
  },
  {
    "table_name": "subscriptions",
    "column_name": "status",
    "data_type": "text",
    "is_nullable": "NO"
  },
  {
    "table_name": "subscriptions",
    "column_name": "current_period_end",
    "data_type": "timestamp with time zone",
    "is_nullable": "YES"
  },
  {
    "table_name": "subscriptions",
    "column_name": "plan_code",
    "data_type": "text",
    "is_nullable": "NO"
  },
  {
    "table_name": "subscriptions",
    "column_name": "updated_at",
    "data_type": "timestamp with time zone",
    "is_nullable": "NO"
  }
]


[
  {
    "table_name": "customers",
    "rls_enabled": true
  },
  {
    "table_name": "logs",
    "rls_enabled": false
  },
  {
    "table_name": "profiles",
    "rls_enabled": true
  },
  {
    "table_name": "subscriptions",
    "rls_enabled": true
  }
]


[
  {
    "schemaname": "public",
    "tablename": "logs",
    "policyname": "logs_insert_own",
    "permissive": "PERMISSIVE",
    "roles": "{public}",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "(auth.uid() = user_id)"
  },
  {
    "schemaname": "public",
    "tablename": "logs",
    "policyname": "logs_select_own",
    "permissive": "PERMISSIVE",
    "roles": "{public}",
    "cmd": "SELECT",
    "qual": "(auth.uid() = user_id)",
    "with_check": null
  },
  {
    "schemaname": "public",
    "tablename": "profiles",
    "policyname": "Users can insert their own profile",
    "permissive": "PERMISSIVE",
    "roles": "{public}",
    "cmd": "INSERT",
    "qual": null,
    "with_check": "(auth.uid() = id)"
  },
  {
    "schemaname": "public",
    "tablename": "profiles",
    "policyname": "Users can view their own profile",
    "permissive": "PERMISSIVE",
    "roles": "{public}",
    "cmd": "SELECT",
    "qual": "(auth.uid() = id)",
    "with_check": null
  }
]

[
  {
    "schema": "public",
    "function_name": "get_my_subscription",
    "args": "",
    "returns": "TABLE(status text, current_period_end timestamp with time zone, plan_code text)"
  },
  {
    "schema": "public",
    "function_name": "search_legal_vector",
    "args": "query_embedding vector, top_k integer, mode text, profile text",
    "returns": "TABLE(id bigint, content text, metadata jsonb, similarity double precision)"
  },
  {
    "schema": "public",
    "function_name": "search_legal_vector",
    "args": "query_embedding vector, match_count integer",
    "returns": "TABLE(id bigint, code_id text, jurisdiction text, citation text, title text, text text, similarity double precision)"
  },
  {
    "schema": "public",
    "function_name": "search_legal_vector_dev",
    "args": "query_embedding vector, match_count integer",
    "returns": "TABLE(id bigint, code_id text, jurisdiction text, citation text, title text, text text, similarity double precision)"
  },
  {
    "schema": "public",
    "function_name": "search_legal_vectors",
    "args": "query_embedding double precision[], match_count integer",
    "returns": "TABLE(id bigint, code_id text, jurisdiction text, citation text, title text, text text, similarity double precision)"
  },
  {
    "schema": "public",
    "function_name": "search_legal_vectors",
    "args": "query_embedding vector, match_count integer",
    "returns": "TABLE(id uuid, code_id text, jurisdiction text, citation text, title text, text text, similarity double precision)"
  },
  {
    "schema": "public",
    "function_name": "search_legal_vectors_dev",
    "args": "query_embedding vector, match_count integer",
    "returns": "TABLE(id bigint, code_id text, jurisdiction text, citation text, title text, text text, similarity double precision)"
  },
  {
    "schema": "public",
    "function_name": "upsert_subscription",
    "args": "p_customer_id text, p_user_id uuid, p_status text, p_current_period_end timestamp with time zone",
    "returns": "void"
  }
]