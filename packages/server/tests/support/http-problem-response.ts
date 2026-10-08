export async function problemOf(response: Response): Promise<{
  readonly text: string; readonly body: Record<string, unknown>;
}> {
  const text = await response.text();
  return { text, body: JSON.parse(text) as Record<string, unknown> };
}

