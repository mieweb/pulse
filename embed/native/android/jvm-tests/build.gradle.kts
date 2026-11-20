// Compiles core/ (plain Kotlin) with the runners in src/main/kotlin and runs one of them:
//
//   gradle --offline -q -p embed/native/android/jvm-tests run --args="$PWD"
//
// `-PmainClass=<fqcn>` picks another runner (default: the shared vectors), so a later runner needs
// no edit here. Output stays in this folder's build/ (git-ignored by the repo's .gradle/ and
// .kotlin/ rules for the caches; delete build/ after a local run).

import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  kotlin("jvm") version "2.1.20"
  application
}

kotlin {
  sourceSets["main"].kotlin.srcDir("../src/main/java/com/mieweb/pulse/kit/core")
  compilerOptions {
    jvmTarget.set(JvmTarget.JVM_17)
    allWarningsAsErrors.set(true)
  }
}

java {
  sourceCompatibility = JavaVersion.VERSION_17
  targetCompatibility = JavaVersion.VERSION_17
}

application {
  mainClass.set(
    providers.gradleProperty("mainClass").orElse("com.mieweb.pulse.kit.vectors.VectorsMain"),
  )
}
