import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";

describe("Health endpoint", () => {
  it("returns a successful response", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      message: "Anonymous Note server is running!",
    });

    await app.close();
  });
});