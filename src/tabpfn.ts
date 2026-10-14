import { config } from "./config.js";

export type PredictionSource = "tabpfn" | "baseline";

type Forecast = {
  source: PredictionSource;
  quantities: Map<string, number>;
  note: string;
};

/**
 * TabPFN-3.5 regression via the JSON API.
 * One fit predicts qty_sold for every candidate price. Dollars stay in pricing.ts.
 */
export async function tabpfnQuantities(
  train: CsvPair,
  testRows: { key: string; csv: string }[],
): Promise<Forecast> {
  const token = config().tabpfnToken;
  if (!token) {
    return { source: "baseline", quantities: new Map(), note: "TABPFN_TOKEN is not set." };
  }

  const base = config().tabpfnBaseUrl;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const trainPrep = await postJson<{
    train_set_upload_id: string;
    x_train_info: UploadInfo;
    y_train_info: UploadInfo;
  }>(`${base}/tabpfn/prepare_train_set_upload`, headers, {
    x_train_info: { format: "csv" },
    y_train_info: { format: "csv" },
  });

  await putSigned(trainPrep.x_train_info, train.x);
  await putSigned(trainPrep.y_train_info, train.y);

  const fitted = await postJson<{ fitted_train_set_id: string }>(
    `${base}/tabpfn/fit`,
    headers,
    {
      train_set_upload_id: trainPrep.train_set_upload_id,
      task_config: {
        task: "regression",
        tabpfn_config: { model_path: "v3.5_default" },
      },
    },
    180_000,
  );

  const testCsv = ["item,price_cents,weather,qty_made,month,festival", ...testRows.map((row) => row.csv)].join(
    "\n",
  );
  const testPrep = await postJson<{
    test_set_upload_id: string;
    x_test_info: UploadInfo;
  }>(`${base}/tabpfn/prepare_test_set_upload`, headers, {
    fitted_train_set_id: fitted.fitted_train_set_id,
    x_test_info: { format: "csv" },
  });
  await putSigned(testPrep.x_test_info, testCsv);

  const predicted = await postJson<{ prediction: unknown }>(`${base}/tabpfn/predict`, headers, {
    test_set_upload_id: testPrep.test_set_upload_id,
    fitted_train_set_id: fitted.fitted_train_set_id,
    task_config: {
      task: "regression",
      predict_params: { output_type: "mean" },
    },
  });

  const values = flattenNumbers(predicted.prediction);
  if (values.length !== testRows.length) {
    throw new Error(
      `TabPFN returned ${values.length} predictions for ${testRows.length} candidate prices.`,
    );
  }

  const quantities = new Map<string, number>();
  testRows.forEach((row, index) => quantities.set(row.key, values[index]));
  return {
    source: "tabpfn",
    quantities,
    note: "TabPFN-3.5 regression (v3.5_default) predicted qty_sold.",
  };
}

type UploadInfo = { signed_urls: string[]; required_headers?: Record<string, string> };
export type CsvPair = { x: string; y: string };

async function putSigned(info: UploadInfo, body: string): Promise<void> {
  const response = await fetch(info.signed_urls[0], {
    method: "PUT",
    headers: info.required_headers ?? { "Content-Type": "text/csv" },
    body,
  });
  if (!response.ok) {
    throw new Error(`TabPFN upload failed (${response.status}).`);
  }
}

async function postJson<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 60_000,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const jsonStart = text.indexOf("{");
  const parsed = jsonStart === -1 ? {} : JSON.parse(text.slice(jsonStart));
  if (!response.ok) {
    const message = typeof parsed.message === "string" ? parsed.message : text.slice(0, 240);
    throw new Error(`TabPFN ${response.status}: ${message}`);
  }
  return parsed as T;
}

function flattenNumbers(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenNumbers(entry));
  }
  if (typeof value === "number" && Number.isFinite(value)) return [value];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["mean", "prediction", "preds", "values"]) {
      if (key in record) return flattenNumbers(record[key]);
    }
  }
  return [];
}
