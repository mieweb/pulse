// A JVM-only build that runs PulseKit's plain-Kotlin core (../src/main/java/.../core) against the
// shared vectors on a Mac or a CI runner: no Android Gradle Plugin, no expo, no device. The Kotlin
// JVM plugin and kotlin-stdlib come from the Gradle cache (`gradle --offline`) or Maven Central.

pluginManagement {
  repositories {
    gradlePluginPortal()
    mavenCentral()
  }
}

dependencyResolutionManagement {
  repositories {
    mavenCentral()
  }
}

rootProject.name = "pulsekit-jvm-tests"
