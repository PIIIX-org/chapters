namespace Elara.Codecs;

public static class Codec
{
    public static byte[] Encode(string value) => System.Text.Encoding.UTF8.GetBytes(value);
}
