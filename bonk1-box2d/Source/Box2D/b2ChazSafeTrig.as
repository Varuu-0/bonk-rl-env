package Box2D
{
	public class b2ChazSafeTrig
	{
		private static const TRIG_PRECISION:Number = 1e7; // 10000000

		private static function roundToPrecision(x:Number) : Number
		{
		  return Math.round(x * TRIG_PRECISION) / TRIG_PRECISION;
		}

		public static function safeSin(x:Number) : Number { return roundToPrecision(Math.sin(x)); }
		public static function safeCos(x:Number) : Number { return roundToPrecision(Math.cos(x)); }
		public static function safeTan(x:Number) : Number { return roundToPrecision(Math.tan(x)); }

		public static function safeASin(x:Number) : Number { return roundToPrecision(Math.asin(x)); }
		public static function safeACos(x:Number) : Number { return roundToPrecision(Math.acos(x)); }
		public static function safeATan(x:Number) : Number { return roundToPrecision(Math.atan(x)); }

		public static function safeATan2(y:Number, x:Number) : Number { return roundToPrecision(Math.atan2(y, x)); }
	}
}
