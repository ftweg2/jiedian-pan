-- Add 'decommissioning' value to the StorageNodeStatus enum so we can mark
-- a node as "being drained" — writes blocked, reads allowed, background
-- migrator copies its chunks to other nodes.
ALTER TYPE "StorageNodeStatus" ADD VALUE 'decommissioning' BEFORE 'disabled';
