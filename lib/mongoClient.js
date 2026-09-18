// Shared MongoDB connection for all three stores (snapshots, reports,
// reminder numbers). Replaces Vercel Blob after an account-wide Blob
// restriction (triggered by a limit hit in a different project sharing the
// same Vercel account) took every Blob-backed feature here down with it —
// a separate service with its own free tier isn't subject to that.
//
// Caches the connection in a module-level variable, which is the standard
// pattern for MongoDB + serverless: this module stays loaded (and the
// connection open) for the lifetime of a warm function instance, so only a
// cold start pays the cost of a fresh connection.
import { MongoClient } from "mongodb";

const DB_NAME = "task-tracker";
let clientPromise;

export async function getDb() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not set — add it as an environment variable (see README).");
  }
  if (!clientPromise) {
    clientPromise = new MongoClient(process.env.MONGODB_URI).connect();
  }
  const client = await clientPromise;
  return client.db(DB_NAME);
}
