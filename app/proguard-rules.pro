# Chaquopy / Python interop — zadrži JavascriptInterface i Chaquopy klase
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.chaquo.python.** { *; }
