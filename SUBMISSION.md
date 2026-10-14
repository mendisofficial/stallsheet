---
title: "StallSheet: a Sunday price desk that does not let the model invent the price"
published: false
tags: devchallenge, hf26challenge, ai
---

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 2: Side Hustle](https://dev.to/challenges/hacktoberfest-week2-2026-10-12)*

## What I Built

**StallSheet** is a Sunday-morning desk for a home baker or craft-stall seller.

They keep a small history of what they made, what they charged, and what actually sold. The app tells them what to bake this weekend, what to charge, and hands them price tags plus a caption they can post.

Someone would pay for this because over-prep wastes ingredients and under-prep loses the day's profit. A general chatbot is a bad fit. The useful part is a forecast on a few dozen of *their* rows, and those rows include margins they should not have to paste into a closed chat log.

The demo stall is Hearth & Rye, a fictional bakery with twelve Saturdays of history stored on Tiger Cloud. A constraint such as "I only have enough butter for 18 cinnamon buns" caps that item before anything is written down.

The model writes. The forecast counts. Gemma is not allowed to invent a price.

## Demo

Clone the repo, copy `.env.example` to `.env`, and point `DATABASE_URL` at a Postgres database with pgvector (the project runs against Tiger Cloud). Add a TabPFN token and a Gemma key, then `npm start` and open http://localhost:3000.

On a sunny Saturday in Portland, with the butter constraint, TabPFN-3.5 priced cinnamon buns at $5.00 and capped the bake at 18. Gemma wrote the caption: "Enjoy the sunny Portland weather at the market. Our cinnamon bun supply is limited by the butter available." The price tags on the page came from the forecast, not from that sentence.

## Code

{% github mendisofficial/stallsheet %}

## How I Built It

One Mastra workflow, pinned at `@mastra/core` 1.77.0 and `@mastra/libsql` 1.26.1. It suspends so the seller can change quantities before the sheet is written. Snapshots sit in a local LibSQL file, so that pause survives a restart of the process.

1. Sales live in Tiger Cloud. A hashed bag-of-words embedding stays in Postgres, so notes are not sent to an embedding API. Hybrid search fuses that pgvector rank with keyword rank. If `pg_textsearch` is installed, the keyword side is BM25. Otherwise it uses `tsvector`.
2. TabPFN-3.5 (`v3.5_default`) predicts `qty_sold` at each price the seller has actually charged. Expected revenue, the chosen price, and the quantity are computed in code.
3. The workflow suspends on `confirm-quantities`.
4. Gemma (`gemma-4-26b-a4b-it` through Google's OpenAI-compatible endpoint) writes the prep list and the caption. Dollar amounts are stripped from the caption. The price tags are printed from the forecast.

Saving the finished sheet uses the Mastra run id as an idempotency key. A restarted step can run a side effect twice. [DevOps Daily measured that on an on-call agent](https://dev.to/devopsdaily/we-built-an-on-call-agent-in-mastra-where-it-won-and-where-it-would-not-obi): recovery is at-least-once, and the fix is a key that survives the restart.

I did not build another freelance quote writer. [BriefBill](https://dev.to/ishaanchowdhury_ic10/briefbill-turning-vague-client-briefs-into-clear-freelance-quotes-with-local-gemma-3-448h) already turns a messy brief into a proposal with Gemma 3, and it keeps the money in ordinary code. StallSheet keeps that rule and puts the forecast in TabPFN.

## Why Does Open Innovation Matter?

The sales table stays on a Postgres database the seller can point at themselves. The embedding never leaves it. Gemma is an open-weight model behind a swappable endpoint, so a Sunday sheet does not depend on one vendor's closed chat API. That closed API would bill every weekend and keep a copy of the margins. TabPFN is the part a general model is bad at: a few dozen rows from this stall, not the internet.

## Prize Categories

- **Best Use of Gemma.** `gemma-4-26b-a4b-it` writes the prep list and the caption. Prices are removed from that text.
- **Best Use of TabPFN.** TabPFN-3.5 regresses `qty_sold` inside the Mastra workflow. The dollars are computed in code from that forecast.
- **Best Use of Mastra.** The confirm step is a real suspend and resume, pinned at Mastra 1.77.0.
- **Best Use of Tiger Data.** Sales and the finished sheet are stored on Tiger Cloud, with pgvector hybrid search over past weekends.
