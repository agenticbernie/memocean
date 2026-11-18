ALTER TABLE memory_chunks DROP CONSTRAINT IF EXISTS memory_chunks_embedding_model_check;
ALTER TABLE memory_chunks ADD CONSTRAINT memory_chunks_embedding_model_check CHECK(length(embedding_model) BETWEEN 1 AND 200);
ALTER TABLE capsule_chunks DROP CONSTRAINT IF EXISTS capsule_chunks_embedding_model_check;
ALTER TABLE capsule_chunks ADD CONSTRAINT capsule_chunks_embedding_model_check CHECK(length(embedding_model) BETWEEN 1 AND 200);
