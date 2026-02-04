import { Slot } from "expo-router";
import { StyleSheet, View } from "react-native";

export default function CameraLayout() {
  return (
    <View style={styles.container}>
      <View style={styles.curvedContainer}>
        <Slot />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#111",
  },
  curvedContainer: {
    flex: 1,
    backgroundColor: "#000",
    borderBottomLeftRadius: 15,
    borderBottomRightRadius: 15,
    overflow: "hidden",
  },
});
